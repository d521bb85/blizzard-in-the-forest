import * as THREE from "three";
import { injectBlizzardFog } from "../render/fog";
import { injectRetro } from "../render/retro";
import { hash3 } from "../lib/noise";
import type { Walker } from "../actors/player";
import type { World } from "./world";

/**
 * The walker's footprints in the snow, done as the console would have done them: a fixed
 * pool of flat quads laid on the snow, oldest reused first; one tiny texture of a felt boot's
 * print, sampled without smoothing or perspective correction; drawn subtracted from the snow
 * under it (the console's B - F semi-transparency, how its games darkened the ground), so
 * the snow's own ripples show through; and filled in by the blizzard in a few hard steps,
 * like a palette swapped frame by frame, the shallow edge and loose crumbs going first.
 */

/** Prints kept at once: at a flat-out run, a little more than one lifetime's worth. */
const POOL = 64;
/** Seconds a print lasts in a calm; gusts fill it faster (FILL_GUST). */
const LIFE = 14;
const FILL_GUST = 1.6;
/** The steps it fills in by, as palette swaps. */
const STAGES = 8;
/** A felt boot's print in deep snow, metres: wider than the boot, longer at a run as the foot drags. */
const WIDTH = 0.15;
const LENGTH = 0.34;
const DRAG = 0.035;
/** Each foot is this far to its side of the line walked, toes out by this much. */
const GAIT = 0.12;
const TOE_OUT = 0.09;
/** Above the snow by this much (and pulled forward in depth), so the snow never shows through. */
const LIFT = 0.012;
/** Higher than the drawn snow by more than this, the foot is on a drift or a trunk, which keep no print. */
const OFF_SNOW = 0.1;
/** How much light the deepest part of a fresh print takes from the snow, in linear light. */
const DEPTH = 0.3;

/**
 * The print, 8 texels across and 16 along, toe first: 1 the shallow edge, 2 the wall, 3 the
 * trodden floor, deepest at the toe and heel.
 */
const SOLE = [
  "..1221..",
  ".123321.",
  "12333321",
  "12333321",
  "12333321",
  "12233221",
  ".122221.",
  "..1221..",
  "..1221..",
  ".122221.",
  "12233221",
  "12333321",
  "12333321",
  "12333321",
  ".123321.",
  "..1111.."
];
const TEX_W = 8;
const TEX_H = SOLE.length;

/**
 * Red: how dark the texel is (its depth). Green: the stage at which it fills in, its depth
 * less a crumb of noise, so the edge goes first and then the floor, ragged, a texel at a time.
 */
function soleTexture(): THREE.DataTexture {
  const data = new Uint8Array(TEX_W * TEX_H * 4);
  for (let y = 0; y < TEX_H; y++) {
    for (let x = 0; x < TEX_W; x++) {
      const level = SOLE[y].charCodeAt(x) - 48;
      const depth = level > 0 && level < 4 ? level / 3 : 0;
      const k = ((TEX_H - 1 - y) * TEX_W + x) * 4;
      const lasts = depth > 0 ? Math.max(0.12, depth - (hash3(x, y, 7, 0x51ed) / 2 ** 32) * 0.3) : 0;
      data[k] = Math.round(depth * 255);
      data[k + 1] = Math.round(lasts * 255);
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, TEX_W, TEX_H, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** In colour the dent takes less blue from the snow than red: shaded snow is a little cool. */
const DENT_TINT = "vec3(1.0, 0.96, 0.87)";

function createTrackMaterial(sole: THREE.Texture): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
    // Snow minus the print; the alpha the eyes that see heat read is left as it is.
    blending: THREE.CustomBlending,
    blendEquation: THREE.ReverseSubtractEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSole = { value: sole };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 aSole;\nattribute float aFill;\nvarying float vFill;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFill = aFill;");
    // The fog takes the print away as it takes the snow under it: less is subtracted, not fog added.
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uSole;\nvarying float vFill;")
      .replace(
        "#include <fog_fragment>",
        `{
          vec4 sole = texture2D(uSole, retroAffine());
          if (sole.g <= vFill) discard;
          vec3 bzRay = vBzWorld - cameraPosition;
          float clear = exp(-vBzDens * vBzDens * dot(bzRay, bzRay));
          float dent = sole.r * ${DEPTH.toFixed(3)} * (1.0 - 0.6 * vFill) * clear;
          gl_FragColor = vec4(mix(vec3(1.0), ${DENT_TINT}, uColour) * dent, 1.0);
        }`
      );
    injectBlizzardFog(shader);
    injectRetro(shader, { affine: "aSole", worldSpace: true });
  };
  return mat;
}

export class Tracks {
  readonly mesh: THREE.Mesh;
  private positions = new Float32Array(POOL * 4 * 3);
  private fills = new Float32Array(POOL * 4).fill(1);
  /** How far each print has filled in, 0 fresh to 1 gone. */
  private ages = new Float32Array(POOL).fill(1);
  private next = 0;
  /** The walker's footsteps as of the last update; null to start counting afresh. */
  private steps: number | null = null;
  private geometry = new THREE.BufferGeometry();
  private sole = soleTexture();

  constructor() {
    const uvs = new Float32Array(POOL * 4 * 2);
    const index = new Uint16Array(POOL * 6);
    for (let p = 0; p < POOL; p++) {
      // Corners: heel left, heel right, toe left, toe right.
      uvs.set([0, 0, 1, 0, 0, 1, 1, 1], p * 8);
      const v = p * 4;
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], p * 6);
    }
    const geo = this.geometry;
    geo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSole", new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute("aFill", new THREE.BufferAttribute(this.fills, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.mesh = new THREE.Mesh(geo, createTrackMaterial(this.sole));
    // The prints are wherever the walker has been: never culled, and drawn after the snow.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Every print gone (a new walk somewhere else). */
  reset(): void {
    this.ages.fill(1);
    this.fills.fill(1);
    this.positions.fill(0);
    this.steps = null;
    this.next = 0;
    this.touch(true);
  }

  /**
   * Fills the prints in, and leaves one wherever a foot has landed since the last update,
   * if `treading` (a person walking, not the yeti, not a scene moving the camera).
   */
  update(dt: number, walker: Walker, world: World, gust: number, treading: boolean): void {
    const rate = (1 + gust * FILL_GUST) / LIFE;
    let moved = false;
    let refill = false;
    for (let p = 0; p < POOL; p++) {
      const age = this.ages[p];
      if (age >= 1) continue;
      const next = Math.min(1, age + dt * rate);
      this.ages[p] = next;
      const was = Math.floor(age * STAGES);
      const now = Math.floor(next * STAGES);
      if (now !== was) {
        this.fills.fill(now / STAGES, p * 4, p * 4 + 4);
        refill = true;
      }
    }
    const steps = walker.steps;
    if (treading && this.steps !== null && steps > this.steps && walker.speed > 0.05) {
      this.lay(walker, world, steps);
      moved = refill = true;
    }
    this.steps = treading ? steps : null;
    this.touch(moved, refill);
  }

  /** One print for the foot that has just landed, the left on odd steps. */
  private lay(walker: Walker, world: World, step: number): void {
    const p = walker.position;
    const side = step & 1 ? -1 : 1;
    const yaw = walker.yaw - side * TOE_OUT;
    // Forward and to the right, on the snow.
    const fx = -Math.sin(walker.yaw);
    const fz = -Math.cos(walker.yaw);
    const cx = p.x - fz * side * GAIT;
    const cz = p.z + fx * side * GAIT;
    if (walker.groundY > world.snowAt(cx, cz) + OFF_SNOW) return;
    const ax = -Math.sin(yaw);
    const az = -Math.cos(yaw);
    const half = (LENGTH + walker.speed * DRAG) / 2;
    const w = WIDTH / 2;
    const slot = this.next;
    this.next = (this.next + 1) % POOL;
    const corners = [
      [-half, -w],
      [-half, w],
      [half, -w],
      [half, w]
    ];
    for (let c = 0; c < 4; c++) {
      const [along, across] = corners[c];
      const x = cx + ax * along - az * across;
      const z = cz + az * along + ax * across;
      this.positions.set([x, world.snowAt(x, z) + LIFT, z], (slot * 4 + c) * 3);
    }
    this.ages[slot] = 0;
    this.fills.fill(0, slot * 4, slot * 4 + 4);
  }

  private touch(moved: boolean, refill = moved): void {
    if (moved) this.geometry.attributes.position.needsUpdate = true;
    if (refill) this.geometry.attributes.aFill.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.sole.dispose();
  }
}
