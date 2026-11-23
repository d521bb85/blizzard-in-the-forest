import * as THREE from "three";
import { blizzardUniforms, FOG_DENSITY_GLSL, NOISE_GLSL, SUN_GLSL } from "./fog";
import type { Weather } from "./blizzard";
import { mulberry32 } from "../lib/noise";

/**
 * Winter breath: faint wisps of vapour exhaled into the freezing air, immediately caught
 * and torn sideways by the blizzard wind. Drives both the visible plume and the timing
 * of the walker's breath sounds so every audible exhale carries mist with it.
 */

export interface BreathEvent {
  kind: "inhale" | "exhale";
  heavy: boolean;
  effort: number;
}

/** Max wisps alive at once (player plus any nearby figure in the fog). */
const POOL = 72;

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aParams;
uniform vec3 fogColor;
varying vec2 vUv;
varying float vAlpha;
varying float vAge;
varying float vSeed;
varying vec3 vColor;
${FOG_DENSITY_GLSL}
${SUN_GLSL}

void main() {
  float alpha = aParams.y;
  if (alpha < 0.002) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  float depth = -mv.z;
  if (depth < 0.08) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // Slow swirl as the wisp expands in the cold air.
  float seed = aParams.w;
  float age = aParams.z;
  float ang = seed * 6.2831 + age * (seed > 0.5 ? 0.85 : -0.85);
  float cs = cos(ang);
  float sn = sin(ang);
  vec2 rot = vec2(position.x * cs - position.y * sn, position.x * sn + position.y * cs);
  mv.xy += rot * aParams.x;

  // Fade gently near the lens so a puff never clips harshly across the whole view.
  float nearFade = smoothstep(0.08, 0.28, depth);
  float f = bzFogFactor(bzFogDensity(aPos), length(aPos - cameraPosition));
  float outAlpha = alpha * nearFade * (1.0 - f * 0.85);
  if (outAlpha < 0.002) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  gl_Position = projectionMatrix * mv;
  vUv = position.xy;
  vAlpha = outAlpha;
  vAge = age;
  vSeed = seed;
  // Pale frost vapour tinted softly by the blizzard air and sun glow.
  vColor = mix(vec3(0.95), fogColor + bzSunGlow(normalize(aPos - cameraPosition)), 0.45 + f * 0.45);
}
`;

const FRAG = /* glsl */ `
uniform float uFogTime;
varying vec2 vUv;
varying float vAlpha;
varying float vAge;
varying float vSeed;
varying vec3 vColor;
${NOISE_GLSL}

void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float radial = smoothstep(1.0, 0.14, r);
  radial *= radial;
  // Wispy frost-mist texture that frays apart as the puff ages and blows away.
  vec3 p = vec3(vUv * 1.9 + vSeed * 13.7, vAge * 1.15 + vSeed * 7.3 + uFogTime * 0.15);
  float n = bzNoise(p) * 0.65 + bzNoise(p * 2.2 + 3.1) * 0.35;
  float wisp = smoothstep(0.2 + vAge * 0.22, 0.84, n);
  float a = vAlpha * radial * (0.32 + 0.68 * wisp);
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor, a);
}
`;

interface Wisp {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  r0: number;
  r1: number;
  opacity: number;
  seed: number;
}

type CyclePhase = "rest" | "inhale" | "exhale";

export class Breath {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private geo: THREE.InstancedBufferGeometry;
  private posAttr: THREE.InstancedBufferAttribute;
  private paramAttr: THREE.InstancedBufferAttribute;
  private wisps: Wisp[];
  private cursor = 0;
  private rand: () => number;

  /** First-person breathing state. */
  private effort = 0;
  private phase: CyclePhase = "rest";
  private left = 1.4;
  private exhaleDur = 0.7;
  private exhaleElapsed = 0;
  private puffEvery = 0.12;
  private puffIn = 0;
  private lastHeavy = false;

  /** Simple timer for a nearby NPC's winter breath (the yeti or the man in the fog). */
  private npcLeft = 1.2;
  private npcExhaleLeft = 0;
  private npcPuffIn = 0;

  private fwd = new THREE.Vector3();
  private up = new THREE.Vector3();
  private right = new THREE.Vector3();

  constructor(seed: number, fogColor: THREE.Color) {
    this.rand = mulberry32(seed ^ 0x4b7e);
    this.wisps = Array.from({ length: POOL }, () => ({
      active: false,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      age: 0,
      life: 1,
      r0: 0.05,
      r1: 0.2,
      opacity: 0,
      seed: 0
    }));

    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.posAttr = new THREE.InstancedBufferAttribute(new Float32Array(POOL * 3), 3);
    this.paramAttr = new THREE.InstancedBufferAttribute(new Float32Array(POOL * 4), 4);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.paramAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("aPos", this.posAttr);
    this.geo.setAttribute("aParams", this.paramAttr);
    this.geo.instanceCount = POOL;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      // Keep the render target's alpha channel untouched so thermal vision never reads breath as a heat source.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      uniforms: {
        ...blizzardUniforms,
        fogColor: { value: fogColor }
      }
    });

    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  /** Clears every active wisp and resets the breathing rhythm (call on restart). */
  reset(): void {
    for (const w of this.wisps) w.active = false;
    this.effort = 0;
    this.phase = "rest";
    this.left = 1.2 + this.rand() * 0.6;
    this.exhaleElapsed = 0;
    this.npcLeft = 0.8 + this.rand() * 0.8;
    this.npcExhaleLeft = 0;
    this.syncBuffers();
  }

  /** Spawns one frost wisp in world space. */
  private spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    r0: number,
    r1: number,
    opacity: number
  ): void {
    const w = this.wisps[this.cursor];
    this.cursor = (this.cursor + 1) % POOL;
    w.active = true;
    w.x = x;
    w.y = y;
    w.z = z;
    w.vx = vx;
    w.vy = vy;
    w.vz = vz;
    w.age = 0;
    w.life = life;
    w.r0 = r0;
    w.r1 = r1;
    w.opacity = opacity;
    w.seed = this.rand();
  }

  /**
   * Advances the player's breathing cycle and every drifting wisp.
   * Returns an event on the exact frame an inhale or exhale begins so audio stays in lockstep.
   */
  update(
    dt: number,
    weather: Weather,
    camera: THREE.PerspectiveCamera,
    walkerVel: THREE.Vector3,
    speed: number,
    heavy: boolean,
    chase: number,
    active: boolean
  ): BreathEvent | null {
    let event: BreathEvent | null = null;

    if (heavy !== this.lastHeavy) {
      this.lastHeavy = heavy;
      this.effort = 0;
      this.phase = "rest";
      this.left = heavy ? 1.8 : 1.2;
    }

    // Smooth physical exertion: builds as you run or sprint, settles back down at a walk or stand.
    const topSpeed = heavy ? 7.6 : 6.2;
    const paceEffort = THREE.MathUtils.clamp((speed - (heavy ? 0.5 : 0.8)) / (topSpeed - (heavy ? 0.5 : 0.8)), 0, 1);
    const targetEffort = active ? Math.max(paceEffort, chase * 0.42) : 0;
    const rate = targetEffort > this.effort ? 0.38 : 0.22;
    this.effort += (targetEffort - this.effort) * (1 - Math.exp(-dt * rate));

    // Camera basis in world space for placing the player's own exhaled mist below eye level.
    camera.matrixWorld.extractBasis(this.right, this.up, this.fwd);
    this.fwd.negate();

    if (active) {
      this.left -= dt;
      if (this.phase === "exhale") {
        this.exhaleElapsed += dt;
        this.puffIn -= dt;
        // Release wisps over the first ~75% of the exhale so the plume tails off naturally.
        if (this.puffIn <= 0 && this.exhaleElapsed < this.exhaleDur * 0.78) {
          this.puffIn += this.puffEvery;
          this.spawnPlayerWisp(weather, camera.position, walkerVel, speed, heavy);
        }
      }
      if (this.left <= 0) {
        const e = this.effort;
        const jitter = 0.92 + this.rand() * 0.16;
        if (this.phase === "rest") {
          this.phase = "inhale";
          this.left = (heavy ? THREE.MathUtils.lerp(0.95, 0.56, e) : THREE.MathUtils.lerp(0.55, 0.34, e)) * jitter;
          event = { kind: "inhale", heavy, effort: e };
        } else if (this.phase === "inhale") {
          this.phase = "exhale";
          this.exhaleDur = (heavy ? THREE.MathUtils.lerp(1.18, 0.72, e) : THREE.MathUtils.lerp(0.7, 0.44, e)) * jitter;
          this.left = this.exhaleDur;
          this.exhaleElapsed = 0;
          const count = heavy ? 7 : 5;
          this.puffEvery = (this.exhaleDur * 0.75) / count;
          this.puffIn = 0;
          this.spawnPlayerWisp(weather, camera.position, walkerVel, speed, heavy);
          event = { kind: "exhale", heavy, effort: e };
        } else {
          this.phase = "rest";
          const period = (heavy ? THREE.MathUtils.lerp(5.0, 2.65, e) : THREE.MathUtils.lerp(3.4, 1.72, e)) * jitter;
          const used = (heavy ? THREE.MathUtils.lerp(2.13, 1.28, e) : THREE.MathUtils.lerp(1.25, 0.78, e)) * jitter;
          this.left = Math.max(heavy ? 0.45 : 0.25, period - used);
        }
      }
    } else if (this.phase !== "rest") {
      this.phase = "rest";
      this.left = 0.9;
    }

    // Advect every active wisp with the blizzard wind so gusts carry breath quickly away.
    const drag = 1 - Math.exp(-dt * (3.1 + weather.gust * 2.6));
    const windVx = weather.wind.x * 0.32;
    const windVy = weather.wind.y * 0.14 + 0.16;
    const windVz = weather.wind.z * 0.32;

    for (const w of this.wisps) {
      if (!w.active) continue;
      w.age += dt;
      if (w.age >= w.life) {
        w.active = false;
        continue;
      }
      w.vx += (windVx - w.vx) * drag;
      w.vy += (windVy - w.vy) * drag;
      w.vz += (windVz - w.vz) * drag;
      w.x += w.vx * dt;
      w.y += w.vy * dt;
      w.z += w.vz * dt;
    }

    this.syncBuffers();
    return event;
  }

  /** Subtle winter breath from a figure seen in the forest (the yeti or the man). */
  updateActor(
    dt: number,
    weather: Weather,
    mouth: THREE.Vector3,
    heading: number,
    heavy: boolean,
    running: boolean,
    distance: number
  ): void {
    const maxDist = heavy ? 28 : 22;
    if (distance > maxDist) return;
    if (this.npcExhaleLeft > 0) {
      this.npcExhaleLeft -= dt;
      this.npcPuffIn -= dt;
      if (this.npcPuffIn <= 0) {
        this.npcPuffIn += heavy ? 0.14 : 0.12;
        const dx = Math.sin(heading);
        const dz = Math.cos(heading);
        const jet = heavy ? 1.15 : 0.75;
        const life = (heavy ? 0.95 : 0.65) / (1 + weather.gust * 0.55);
        const spread = heavy ? 0.08 : 0.04;
        this.spawn(
          mouth.x + dx * (heavy ? 0.12 : 0.06) + (this.rand() - 0.5) * spread,
          mouth.y + (this.rand() - 0.5) * spread,
          mouth.z + dz * (heavy ? 0.12 : 0.06) + (this.rand() - 0.5) * spread,
          dx * jet + (this.rand() - 0.5) * 0.18,
          0.1 + (this.rand() - 0.5) * 0.08,
          dz * jet + (this.rand() - 0.5) * 0.18,
          life,
          heavy ? 0.09 : 0.045,
          heavy ? 0.34 : 0.17,
          heavy ? 0.16 : 0.11
        );
      }
      return;
    }
    this.npcLeft -= dt;
    if (this.npcLeft <= 0) {
      this.npcExhaleLeft = heavy ? (running ? 0.65 : 0.95) : running ? 0.38 : 0.55;
      this.npcPuffIn = 0;
      const period = heavy ? (running ? 2.4 : 4.2) : running ? 1.6 : 3.0;
      this.npcLeft = period * (0.85 + this.rand() * 0.3);
    }
  }

  private spawnPlayerWisp(
    weather: Weather,
    eye: THREE.Vector3,
    walkerVel: THREE.Vector3,
    speed: number,
    heavy: boolean
  ): void {
    const e = this.effort;
    const fwdDist = heavy ? 0.44 : 0.36;
    const downDist = heavy ? 0.2 : 0.165;
    const side = (this.rand() - 0.5) * (heavy ? 0.06 : 0.04);
    const x = eye.x + this.fwd.x * fwdDist - this.up.x * downDist + this.right.x * side;
    const y = eye.y + this.fwd.y * fwdDist - this.up.y * downDist + this.right.y * side;
    const z = eye.z + this.fwd.z * fwdDist - this.up.z * downDist + this.right.z * side;

    const jet = (heavy ? 1.35 : 1.08) + speed * 0.12 + e * 0.2;
    const lift = heavy ? 0.05 : 0.085;
    const driftSide = (this.rand() - 0.5) * 0.14;
    const vx = walkerVel.x + this.fwd.x * jet + this.up.x * lift + this.right.x * driftSide;
    const vy = walkerVel.y + this.fwd.y * jet + this.up.y * lift + this.right.y * driftSide;
    const vz = walkerVel.z + this.fwd.z * jet + this.up.z * lift + this.right.z * driftSide;

    const life = (heavy ? 0.92 : 0.68) / (1 + weather.gust * 0.55);
    const scale = 1 + e * 0.2;
    const r0 = (heavy ? 0.072 : 0.048) * scale;
    const r1 = (heavy ? 0.27 : 0.19) * scale;
    const opacity = (heavy ? 0.14 : 0.11) + e * (heavy ? 0.04 : 0.032);
    this.spawn(x, y, z, vx, vy, vz, life, r0, r1, opacity);
  }

  private syncBuffers(): void {
    const pos = this.posAttr.array as Float32Array;
    const par = this.paramAttr.array as Float32Array;
    for (let i = 0; i < POOL; i++) {
      const w = this.wisps[i];
      if (!w.active) {
        par[i * 4 + 1] = 0;
        continue;
      }
      const u = w.age / w.life;
      // Soft onset, then thinning away smoothly as the blizzard carries it off.
      const fadeIn = Math.min(1, u / 0.16);
      const fadeOut = (1 - u) ** 1.55;
      const radius = w.r0 + (w.r1 - w.r0) * (1 - Math.exp(-w.age * 3.1));
      pos[i * 3] = w.x;
      pos[i * 3 + 1] = w.y;
      pos[i * 3 + 2] = w.z;
      par[i * 4] = radius;
      par[i * 4 + 1] = w.opacity * fadeIn * fadeOut;
      par[i * 4 + 2] = u;
      par[i * 4 + 3] = w.seed;
    }
    this.posAttr.needsUpdate = true;
    this.paramAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}
