import * as THREE from "three";
import { blizzardUniforms, FOG_DENSITY_GLSL, SUN_GLSL } from "./fog";
import { mulberry32, wave1 } from "../lib/noise";

/** How much sunlight the glow adds to the fog at most, in linear units (the fog itself is about 0.22). */
const SUN_STRENGTH = 0.1;

/**
 * Where the weather's clock starts: about fifty seconds of calmer air, so the
 * forest (and the first deer) can be seen before the first strong gust comes through.
 */
const CALM_START = 204;

/** Wind direction, speed and gusts; drives fog, flakes, trees and the sun's glow. */
export class Weather {
  time = CALM_START;
  gust = 0.5;
  readonly wind = new THREE.Vector3();
  readonly offset = new THREE.Vector3();
  private baseAngle: number;

  /** Multiplies fog density; phones use a shorter view radius and slightly thicker air. */
  constructor(seed: number, private fogScale = 1) {
    this.baseAngle = mulberry32(seed)() * Math.PI * 2;
  }

  /** Back to the calm air of a first visit: a new walk opens as clear as the first one did. */
  reset(): void {
    this.time = CALM_START;
  }

  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    // Slow swell plus sharper gusts on top.
    const swell = 0.5 + 0.5 * wave1(t * 0.07, 1.3);
    const burst = Math.max(0, wave1(t * 0.31, 4.1)) ** 2;
    this.gust = Math.min(1, swell * 0.7 + burst * 0.6);
    const angle = this.baseAngle + wave1(t * 0.013, 2.2) * 0.6 + wave1(t * 0.21, 7.7) * 0.12;
    const speed = 7 + this.gust * 11;
    this.wind.set(Math.cos(angle) * speed, Math.sin(t * 0.9) * 0.6 * this.gust, Math.sin(angle) * speed);
    this.offset.addScaledVector(this.wind, dt);

    const u = blizzardUniforms;
    u.uWindOffset.value.copy(this.offset);
    u.uFogTime.value = t;
    u.uGust.value = this.gust;
    u.uWindDir.value.set(Math.cos(angle), Math.sin(angle));
    // Clearer air while the walk begins, thickening to the usual over the first minute.
    const opening = THREE.MathUtils.lerp(0.72, 1, THREE.MathUtils.smoothstep(t - CALM_START, 25, 55));
    u.uFogDensity.value = (0.04 + this.gust * 0.024) * this.fogScale * opening;
    // The sun comes and goes as thicker cloud drifts over, and all but vanishes in strong gusts.
    const breaks = 0.5 + 0.5 * wave1(t * 0.021, 5.5);
    u.uSun.value = SUN_STRENGTH * (0.35 + 0.65 * breaks * breaks) * (1 - 0.55 * this.gust);
  }
}

/** Drift wraps after this many boxes; flake speed factors are k / DRIFT_WRAP. */
const DRIFT_WRAP = 80;

const VERT = /* glsl */ `
attribute vec3 aOffset;
attribute vec4 aRand;
uniform vec3 uAnchor;
uniform vec3 uBox;
uniform vec3 uDrift;
uniform vec3 uVel;
uniform vec2 uSlope;
uniform float uTime;
uniform float uStreak;
uniform float uPixelAngle;
uniform float uFinePixelAngle;
uniform float uSize;
uniform float uOpacity;
uniform float uGust;
uniform vec3 fogColor;
varying float vAlpha;
varying vec2 vUv;
varying vec3 vColor;
${FOG_DENSITY_GLSL}
${SUN_GLSL}

void main() {
  // Quantised so that wrapping the drift by DRIFT_WRAP boxes is seamless for every flake.
  float speedVar = 0.8 + floor(aRand.z * 32.0) / ${DRIFT_WRAP.toFixed(1)};
  float ph = aRand.y * 6.2831;
  float tw = 0.5 + uGust;
  vec3 turb = vec3(
    sin(uTime * 1.7 + ph) + 0.5 * sin(uTime * 4.3 + ph * 3.0),
    0.6 * sin(uTime * 2.3 + ph * 2.0),
    cos(uTime * 1.3 + ph * 1.5) + 0.5 * cos(uTime * 3.7 + ph * 2.5)
  ) * tw * 0.6;
  vec3 turbVel = vec3(
    1.7 * cos(uTime * 1.7 + ph) + 2.15 * cos(uTime * 4.3 + ph * 3.0),
    1.38 * cos(uTime * 2.3 + ph * 2.0),
    -1.3 * sin(uTime * 1.3 + ph * 1.5) - 1.85 * sin(uTime * 3.7 + ph * 2.5)
  ) * tw * 0.6;

  vec3 p = aOffset * uBox + uDrift * speedVar + turb;
  vec3 rel = mod(p - uAnchor + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 world = uAnchor + rel;
  world.y += dot(uSlope, rel.xz);

  vec3 q = abs(rel) / (uBox * 0.5);
  float edge = 1.0 - smoothstep(0.7, 1.0, max(q.x, max(q.y, q.z)));

  vec3 vel = uVel * speedVar + turbVel;
  vec4 v0 = viewMatrix * vec4(world, 1.0);
  vec4 v1 = viewMatrix * vec4(world - vel * uStreak, 1.0);

  float depth = max(-v0.z, 0.001);
  float size = uSize * mix(0.5, 1.5, aRand.x);
  // At least a whole scene pixel across (the quad spans 2w): with no anti-aliasing,
  // thinner flakes would blink.
  float w = max(size, depth * uPixelAngle * 0.5);
  // Each flake gives as much light as it did on a fine, screen-resolution render
  // (where it was 1.5 pixels wide at the least), only spread over coarser pixels.
  float fineW = max(size, depth * uFinePixelAngle * 0.75);
  float alpha = uOpacity * aRand.w * (size / w) * (fineW / w);

  vec2 d = v1.xy - v0.xy;
  float len = length(d);
  vec2 dir = len > 1e-5 ? d / len : vec2(0.0, 1.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec3 base = mix(v0.xyz, v1.xyz, position.x);
  base.xy += nrm * position.y * w + dir * (position.x * 2.0 - 1.0) * w;
  alpha *= clamp(w * 4.0 / (len + w * 4.0), 0.3, 1.0);
  alpha *= smoothstep(0.08, 0.5, depth) * edge;

  // Fog is constant across a flake, so it is evaluated once per vertex.
  float f = bzFogFactor(bzFogDensity(world), length(world - cameraPosition));
  alpha *= 1.0 - f * 0.75;
  if (alpha < 0.002) {
    // Invisible: move the quad off-screen so it is never rasterised.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  gl_Position = projectionMatrix * vec4(base, 1.0);
  vUv = position.xy;
  vAlpha = alpha;
  vColor = mix(vec3(1.0), fogColor + bzSunGlow(normalize(world - cameraPosition)), f * 0.8);
}
`;

const FRAG = /* glsl */ `
varying float vAlpha;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  float across = 1.0 - vUv.y * vUv.y;
  float along = smoothstep(0.0, 0.15, vUv.x) * smoothstep(1.0, 0.85, vUv.x);
  gl_FragColor = vec4(vColor, vAlpha * across * (0.4 + 0.6 * along));
}
`;

interface LayerOptions {
  count: number;
  box: THREE.Vector3;
  size: number;
  opacity: number;
  windScale: number;
  fall: number;
  ground: boolean;
}

/** One volume of wind-driven, motion-streaked flakes that wraps around the camera. */
class FlakeLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private drift = new THREE.Vector3();

  constructor(seed: number, private opts: LayerOptions, fogColor: THREE.Color) {
    const rand = mulberry32(seed);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3)
    );
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const offsets = new Float32Array(opts.count * 3);
    const rnd = new Float32Array(opts.count * 4);
    for (let i = 0; i < opts.count; i++) {
      offsets[i * 3] = rand();
      offsets[i * 3 + 1] = rand();
      offsets[i * 3 + 2] = rand();
      rnd[i * 4] = rand() ** 2;
      rnd[i * 4 + 1] = rand();
      rnd[i * 4 + 2] = rand();
      rnd[i * 4 + 3] = 0.45 + rand() * 0.55;
    }
    geo.setAttribute("aOffset", new THREE.InstancedBufferAttribute(offsets, 3));
    geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(rnd, 4));
    geo.instanceCount = opts.count;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        ...blizzardUniforms,
        fogColor: { value: fogColor },
        uAnchor: { value: new THREE.Vector3() },
        uBox: { value: opts.box.clone() },
        uDrift: { value: this.drift },
        uVel: { value: new THREE.Vector3() },
        uSlope: { value: new THREE.Vector2() },
        uTime: { value: 0 },
        uStreak: { value: 0.008 },
        uPixelAngle: { value: 0.002 },
        uFinePixelAngle: { value: 0.001 },
        uSize: { value: opts.size },
        uOpacity: { value: opts.opacity }
      }
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.ground ? 1 : 2;
  }

  update(
    dt: number,
    weather: Weather,
    anchor: THREE.Vector3,
    camVel: THREE.Vector3,
    slope: THREE.Vector2,
    pixelAngle: number,
    finePixelAngle: number
  ): void {
    const o = this.opts;
    const vx = weather.wind.x * o.windScale;
    const vy = o.ground ? weather.wind.y * 0.2 : weather.wind.y - o.fall;
    const vz = weather.wind.z * o.windScale;
    this.drift.x += vx * dt;
    this.drift.y += vy * dt;
    this.drift.z += vz * dt;
    // Keep the accumulator small for float precision. Every flake's speed factor
    // times DRIFT_WRAP is a whole number of boxes, so the wrap is invisible.
    const b = o.box;
    this.drift.set(this.drift.x % (b.x * DRIFT_WRAP), this.drift.y % (b.y * DRIFT_WRAP), this.drift.z % (b.z * DRIFT_WRAP));
    const u = this.material.uniforms;
    u.uAnchor.value.copy(anchor);
    u.uVel.value.set(vx - camVel.x, vy - camVel.y, vz - camVel.z);
    u.uTime.value = weather.time;
    u.uPixelAngle.value = pixelAngle;
    u.uFinePixelAngle.value = finePixelAngle;
    if (o.ground) u.uSlope.value.copy(slope);
  }
}

export class Blizzard {
  readonly group = new THREE.Group();
  private falling: FlakeLayer;
  private near: FlakeLayer;
  private ground: FlakeLayer;
  private anchor = new THREE.Vector3();

  constructor(seed: number, fogColor: THREE.Color, quality: number) {
    this.falling = new FlakeLayer(seed ^ 1, {
      count: Math.round(42000 * quality),
      box: new THREE.Vector3(44, 26, 44),
      size: 0.009,
      opacity: 0.75,
      windScale: 1,
      fall: 1.4,
      ground: false
    }, fogColor);
    this.near = new FlakeLayer(seed ^ 2, {
      count: Math.round(1600 * quality),
      box: new THREE.Vector3(7, 5, 7),
      size: 0.006,
      opacity: 0.8,
      windScale: 1.1,
      fall: 1.2,
      ground: false
    }, fogColor);
    this.ground = new FlakeLayer(seed ^ 3, {
      count: Math.round(9000 * quality),
      box: new THREE.Vector3(36, 0.9, 36),
      size: 0.012,
      opacity: 0.4,
      windScale: 1.35,
      fall: 0,
      ground: true
    }, fogColor);
    this.group.add(this.ground.mesh, this.falling.mesh, this.near.mesh);
  }

  /**
   * renderHeight: the scene's height in pixels. fineHeight: the height of a
   * screen-resolution render, which sets how bright each flake is.
   */
  update(
    dt: number,
    weather: Weather,
    camera: THREE.PerspectiveCamera,
    camVel: THREE.Vector3,
    groundY: number,
    slope: THREE.Vector2,
    renderHeight: number,
    fineHeight: number
  ): void {
    const span = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const pa = span / Math.max(1, renderHeight);
    const fine = span / Math.max(1, fineHeight);
    this.falling.update(dt, weather, camera.position, camVel, slope, pa, fine);
    this.near.update(dt, weather, camera.position, camVel, slope, pa, fine);
    this.anchor.set(camera.position.x, groundY + 0.35, camera.position.z);
    this.ground.update(dt, weather, this.anchor, camVel, slope, pa, fine);
  }
}
