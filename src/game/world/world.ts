import * as THREE from "three";
import { injectBlizzardFog } from "../render/fog";
import { injectRetro, SNOW_TEXELS } from "../render/retro";
import { createSimplex2, hash3, mulberry32, smoothstep } from "../lib/noise";
import { buildTerrainGeometry, createHills, createHollows, drawnHeight, prevailingWindAngle, type HeightField } from "./terrain";
import { LogBuilder } from "./logs";
import { MATTER, type TreeKind, type TreeVariant } from "./trees";
import type { Collider } from "./collider";

const CHUNK = 32;
const SEGMENTS = 32;
const CELL = 4;
/** Default streaming radius; fog makes anything beyond it invisible. */
export const VIEW_RADIUS = 92;
const SPAWN_CLEAR = 9;

/** Drifts no taller than this (in metres) can be walked over. */
const MAX_CLIMB = 0.8;
/** Places per chunk where a fallen trunk may lie (biotope sets the chance). */
const LOG_TRIES = 4;
/** Minimum navigable clearance between solid trunk/boulder walk colliders (m). */
const MIN_PASS_GAP = 1.45;
/** Texels per metre of the "texture" on trees and everything else of wood and stone. */
const BARK_TEXELS = 14;

/** How each kind of thing stands in the snow: scale range, sink depth, lean tilt, and canopy inhibition radius. */
const PLACE: Record<TreeKind, { scale: [number, number]; sink: [number, number]; tilt: number; inhibit: number }> = {
  fir: { scale: [0.8, 1.2], sink: [0.25, 0.5], tilt: 0.035, inhibit: 1.8 },
  spruce: { scale: [0.78, 1.22], sink: [0.25, 0.55], tilt: 0.045, inhibit: 2.1 },
  subSpruce: { scale: [0.8, 1.2], sink: [0.2, 0.45], tilt: 0.05, inhibit: 1.5 },
  young: { scale: [0.75, 1.25], sink: [0.18, 0.42], tilt: 0.055, inhibit: 1.1 },
  cedar: { scale: [0.85, 1.2], sink: [0.25, 0.5], tilt: 0.035, inhibit: 3.8 },
  pine: { scale: [0.82, 1.2], sink: [0.25, 0.5], tilt: 0.045, inhibit: 3.6 },
  larch: { scale: [0.82, 1.22], sink: [0.25, 0.5], tilt: 0.04, inhibit: 3.4 },
  birch: { scale: [0.78, 1.2], sink: [0.2, 0.45], tilt: 0.09, inhibit: 2.3 },
  birchClump: { scale: [0.8, 1.18], sink: [0.2, 0.4], tilt: 0.07, inhibit: 2.8 },
  aspen: { scale: [0.82, 1.18], sink: [0.22, 0.45], tilt: 0.05, inhibit: 2.5 },
  snag: { scale: [0.75, 1.22], sink: [0.25, 0.55], tilt: 0.12, inhibit: 1.8 },
  birchSnag: { scale: [0.8, 1.2], sink: [0.2, 0.45], tilt: 0.14, inhibit: 1.6 },
  mound: { scale: [0.6, 1.45], sink: [0, 0], tilt: 0, inhibit: 1.6 },
  bush: { scale: [0.7, 1.3], sink: [0, 0.15], tilt: 0.1, inhibit: 0 },
  tallBush: { scale: [0.75, 1.25], sink: [0.05, 0.2], tilt: 0.14, inhibit: 0 },
  grass: { scale: [0.7, 1.3], sink: [0, 0.1], tilt: 0.1, inhibit: 0 },
  stump: { scale: [0.8, 1.25], sink: [0.05, 0.25], tilt: 0.08, inhibit: 1.2 },
  rock: { scale: [0.7, 1.4], sink: [0.05, 0.3], tilt: 0.25, inhibit: 1.8 }
};

type Biotope = "darkTaiga" | "pineRidge" | "birchGrove" | "bog" | "clearing";
type Mix = [TreeKind, number][];

/** Layer-1 species mixes for the West/South Siberian taiga catena. */
const BIOTOPE_MIX: Record<Biotope, Mix> = {
  // Primary West/South Siberian dark-conifer taiga: fir, spruce, Siberian cedar, rare old deciduous.
  darkTaiga: [
    ["fir", 0.4],
    ["spruce", 0.4],
    ["cedar", 0.14],
    ["aspen", 0.03],
    ["birch", 0.03]
  ],
  // Dry high ridges: spacious Scots pine & winter larch colonnade.
  pineRidge: [
    ["pine", 0.68],
    ["larch", 0.22],
    ["cedar", 0.05],
    ["birch", 0.05]
  ],
  // Successional birch-aspen groves & edges (Layer-2 spruce/fir grows underneath).
  birchGrove: [
    ["birchClump", 0.32],
    ["birch", 0.23],
    ["aspen", 0.3],
    ["larch", 0.08],
    ["spruce", 0.07]
  ],
  // Frozen creek banks & bog margins: stunted conifers & crooked birches.
  bog: [
    ["birch", 0.38],
    ["birchClump", 0.16],
    ["spruce", 0.24],
    ["larch", 0.12],
    ["young", 0.1]
  ],
  // Outer forest mantle stepping up from open snow (inner clearing has almost no trees).
  clearing: [
    ["young", 0.3],
    ["subSpruce", 0.2],
    ["birchClump", 0.18],
    ["birch", 0.14],
    ["aspen", 0.1],
    ["larch", 0.04],
    ["pine", 0.04]
  ]
};

const LOG_CHANCE: Record<Biotope, number> = {
  darkTaiga: 0.42,
  birchGrove: 0.18,
  pineRidge: 0.06,
  bog: 0.04,
  clearing: 0.03
};

/** The trees (and everything else instanced) of one variant in one chunk. */
interface Stand {
  /** Instance matrices in chunk-local coordinates, 16 floats each. */
  matrices: Float32Array;
  /** Bounding spheres in world coordinates, with room for wind sway: x, y, z, r each. */
  spheres: Float64Array;
}

interface Chunk {
  key: number;
  cx: number;
  cz: number;
  /** The snowfield and the fallen trunks; the trees are drawn in batches across chunks. */
  group: THREE.Group;
  /** The snowfield tile itself, rebuilt if a clearing levels the ground under it. */
  terrain: THREE.Mesh;
  /** The fallen trunks' meshes in the group, rebuilt with the trees when a clearing is made. */
  logs: THREE.Mesh[];
  colliders: Collider[];
  /** By variant; null where the chunk has none of it. */
  stands: (Stand | null)[];
  /** Around every tree of the chunk, for skipping whole chunks out of view. */
  bounds: THREE.Box3;
  /** New for every build of the trees, so batches know when theirs have changed. */
  serial: number;
}

/** One instanced mesh per variant for all chunks: a draw call each, whatever the number of chunks. */
interface Batch {
  mesh: THREE.InstancedMesh;
  /** Which tree is in each slot (chunk serial and index), to upload only when that changes. */
  ids: number[];
  count: number;
}

/** A map key for a chunk's coordinates. */
const keyOf = (cx: number, cz: number) => (cx + 0x8000) * 0x10000 + (cz + 0x8000);

/**
 * A hue as a GLSL vec3 to multiply a gray by: given as it looks on screen, kept
 * in linear light and scaled so that the gray stays as bright as it was.
 */
function tint(r: number, g: number, b: number): string {
  const lin = [r, g, b].map((c) => Math.pow(c, 2.2));
  const luma = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return `vec3(${lin.map((c) => (c / luma).toFixed(4)).join(", ")})`;
}

/** In colour the darkest grays are this much brighter, fading to no change by mid gray. */
export const COLOUR_LIFT = 2.6;

/** The colours of a cold, overcast Siberian winter forest. Snow is white in the light and cool in shade. */
const SNOW_LIGHT = tint(0.98, 0.99, 1.0);
const SNOW_SHADE = tint(0.93, 0.95, 0.98);
const BARK_BROWN = tint(0.45, 0.29, 0.18);
const NEEDLE_GREEN = tint(0.1, 0.29, 0.15);
const STONE = tint(0.47, 0.49, 0.54);
const STRAW = tint(0.72, 0.56, 0.24);
const PLANK = tint(0.56, 0.38, 0.22);
const BIRCH_MARK = tint(0.3, 0.27, 0.25);
const BIRCH_PALE = tint(1.0, 0.96, 0.88);
const PINE_BARK = tint(0.68, 0.42, 0.24);
const ASPEN_BARK = tint(0.5, 0.52, 0.46);

export function createSnowMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    injectBlizzardFog(shader);
    injectRetro(shader, { affine: "vBzWorld.xz", worldSpace: true });
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      {
        vec2 w = (floor(retroAffine() * ${SNOW_TEXELS.toFixed(1)}) + 0.5) / ${SNOW_TEXELS.toFixed(1)};
        vec2 r = vec2(w.x * 0.8 + w.y * 0.6, -w.x * 0.6 + w.y * 0.8);
        float patches = bzNoise(vec3(w * 0.25, 1.7));
        float ripples = bzNoise(vec3(r.x * 3.2, r.y * 0.7, 4.1));
        float grain = bzNoise(vec3(w * 7.0, 9.3));
        float shade = 0.86 + patches * 0.12 - ripples * 0.07 + grain * 0.05;
        diffuseColor.rgb *= shade;
        vec3 hue = mix(${SNOW_SHADE}, ${SNOW_LIGHT}, smoothstep(0.8, 0.98, shade));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * hue, uColour);
      }`
    );
  };
  return mat;
}

export function createTreeMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide
  });
  mat.onBeforeCompile = (shader) => {
    injectBlizzardFog(shader);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform vec2 uWindDir;
        uniform float uGust;
        attribute float matter;
        attribute float flex;
        varying vec3 vHue;
        varying float vPlaster;
        // The hue a gray takes in colour, by what the vertex is made of: its own
        // while dark, snow once pale enough to be the snow lying on it.
        vec3 hueOf(float m, float gray) {
          vec3 snow = mix(${SNOW_SHADE}, ${SNOW_LIGHT}, smoothstep(0.6, 0.93, gray));
          if (m < ${MATTER.wood + 0.5}) return mix(${BARK_BROWN}, snow, smoothstep(0.5, 0.75, gray));
          if (m < ${MATTER.needle + 0.5}) return mix(${NEEDLE_GREEN}, snow, smoothstep(0.4, 0.7, gray));
          if (m < ${MATTER.snow + 0.5}) return snow;
          if (m < ${MATTER.rock + 0.5}) return mix(${STONE}, snow, smoothstep(0.5, 0.8, gray));
          if (m < ${MATTER.straw + 0.5}) return ${STRAW};
          if (m < ${MATTER.plank + 0.5}) return mix(${PLANK}, snow, smoothstep(0.77, 0.83, gray));
          if (m < ${MATTER.birch + 0.5}) return mix(${BIRCH_MARK}, ${BIRCH_PALE}, smoothstep(0.4, 0.7, gray));
          if (m < ${MATTER.pineBark + 0.5}) return mix(${PINE_BARK}, snow, smoothstep(0.58, 0.8, gray));
          return mix(${ASPEN_BARK}, snow, smoothstep(0.62, 0.82, gray));
        }`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vPlaster = 0.0;
        #ifdef USE_INSTANCING
        {
          mat3 im = mat3(instanceMatrix);
          float s2 = dot(im[0], im[0]);
          vec3 localWind = transpose(im) * vec3(uWindDir.x, 0.0, uWindDir.y) / s2;
          // Batches are placed on a chunk corner, so this is the position within the chunk.
          float ph = dot(mod(instanceMatrix[3].xz, ${CHUNK.toFixed(1)}), vec2(0.37, 0.23));
          float h = max(position.y, 0.0);
          float sway = uGust * (0.7 + 0.3 * sin(uFogTime * 1.1 + ph))
                     + 0.25 * sin(uFogTime * 2.6 + ph * 1.7 + h * 0.3);
          transformed += localWind * sway * (h * h * 0.0015 + min(h, 2.5) * 0.014) * flex;
          // World-space windward snow plastering on bark (wood, birch, pineBark, aspen).
          float isBark = (matter < 0.5 || matter > 5.5) ? 1.0 : 0.0;
          vec3 wn = normalize(im * normal);
          float horiz = length(wn.xz);
          float windFace = horiz > 0.15 ? max(0.0, dot(wn.xz / horiz, -uWindDir)) : 0.0;
          // Stronger on lower and middle trunk, thinning out high in the wind-scoured crown.
          float heightFade = 1.0 - smoothstep(4.0, 15.0, h) * 0.45;
          vPlaster = isBark * smoothstep(0.28, 0.92, windFace) * heightFade;
        }
        #endif
        vHue = hueOf(matter, pow(color.r, 1.0 / 2.2));`
      );
    injectRetro(shader, { affine3: "position" });
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          vec3 t = retroAffine3() * ${BARK_TEXELS.toFixed(1)};
          vec3 cell = floor(vec3(t.x, t.y * 0.4, t.z));
          float fine = bzHash(cell);
          float coarse = bzHash(floor(cell * vec3(0.5, 0.25, 0.5)) + 31.0);
          float amp = mix(0.6, 0.1, smoothstep(0.02, 0.4, diffuseColor.r));
          diffuseColor.rgb *= 1.0 + amp * (fine * 1.3 + coarse * 0.7 - 1.0);
          // Patchy snow streaks plastered onto the windward side of every trunk in unison.
          float snowMask = smoothstep(0.45, 0.78, vPlaster * (0.45 + 0.65 * coarse + 0.25 * fine));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.76), snowMask);
          vec3 hue = mix(vHue, ${SNOW_LIGHT}, snowMask);
          // Dark wood and needles are lifted out of the black, or their colour would not show.
          float lift = mix(${COLOUR_LIFT.toFixed(1)}, 1.0, smoothstep(0.0, 0.3, diffuseColor.r));
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * hue * lift, uColour);
        }`
      )
      .replace("#include <common>", "#include <common>\nvarying vec3 vHue;\nvarying float vPlaster;");
  };
  return mat;
}

/** Streams terrain and forest chunks around the walker; everything is regenerated from the seed. */
export class World {
  readonly group = new THREE.Group();
  private chunks = new Map<number, Chunk>();
  /** The chunks in the view radius, nearest first, as of the last update(). */
  private inView: Chunk[] = [];
  private batches: Batch[];
  private serial = 0;
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  /** The chunks with trees in the frustum, refilled by cull(). */
  private visible: Chunk[] = [];
  private density;
  private detail;
  private stand;
  private patch;
  private hills;
  private hollows;
  private wind: number;
  /** The variants of each kind, by index. */
  private kinds = new Map<TreeKind, number[]>();
  /** Colliders of things placed into the world from outside it (a signpost, a hut). */
  private extras: Collider[] = [];
  /** Circles kept free of trees, drifts and fallen trunks (and optionally levelled flat). */
  private clearings: { x: number; z: number; r: number; levelled: boolean }[] = [];

  constructor(
    private seed: number,
    private height: HeightField,
    private variants: TreeVariant[],
    private snowMaterial: THREE.Material,
    private treeMaterial: THREE.Material,
    private viewRadius = VIEW_RADIUS
  ) {
    this.density = createSimplex2(seed ^ 0x51ed270b);
    this.detail = createSimplex2(seed ^ 0x3c6ef372);
    this.stand = createSimplex2(seed ^ 0x1f83d9ab);
    this.patch = createSimplex2(seed ^ 0x4b1d9c37);
    this.hills = createHills(seed);
    this.hollows = createHollows(seed);
    this.wind = prevailingWindAngle(seed);
    variants.forEach((v, i) => {
      const list = this.kinds.get(v.kind);
      if (list) list.push(i);
      else this.kinds.set(v.kind, [i]);
      if (!v.geometry.boundingSphere) v.geometry.computeBoundingSphere();
    });
    this.batches = variants.map((v) => ({ mesh: this.batchMesh(v.geometry, 64), ids: [], count: 0 }));
  }

  private batchMesh(geometry: THREE.BufferGeometry, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, this.treeMaterial, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Culled tree by tree in cull().
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * Fills each variant's batch with its trees that may be in view, nearest chunks
   * first. Call once the camera's matrices are up to date, before rendering.
   */
  cull(camera: THREE.Camera): void {
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = this.frustum.setFromProjectionMatrix(this.projView);
    const planes = frustum.planes;
    const visible = this.visible;
    visible.length = 0;
    for (const c of this.inView) if (!c.bounds.isEmpty() && frustum.intersectsBox(c.bounds)) visible.push(c);
    // The batches sit on the corner of the camera's chunk, so instance offsets stay small.
    const originX = Math.floor(camera.position.x / CHUNK) * CHUNK;
    const originZ = Math.floor(camera.position.z / CHUNK) * CHUNK;
    for (let v = 0; v < this.batches.length; v++) {
      let batch = this.batches[v];
      let room = 0;
      for (const c of visible) room += c.stands[v] ? c.stands[v]!.spheres.length / 4 : 0;
      if (room > batch.mesh.instanceMatrix.count) {
        const old = batch.mesh;
        this.group.remove(old);
        old.dispose();
        batch = this.batches[v] = { mesh: this.batchMesh(old.geometry, Math.max(room, old.instanceMatrix.count * 2)), ids: [], count: 0 };
      }
      const mesh = batch.mesh;
      const moved = mesh.position.x !== originX || mesh.position.z !== originZ;
      const out = mesh.instanceMatrix.array as Float32Array;
      const ids = batch.ids;
      let n = 0;
      let changed = moved;
      for (const c of visible) {
        const stand = c.stands[v];
        if (!stand) continue;
        const { matrices, spheres } = stand;
        const dx = c.cx * CHUNK - originX;
        const dz = c.cz * CHUNK - originZ;
        for (let k = 0, count = spheres.length / 4; k < count; k++) {
          const x = spheres[k * 4];
          const y = spheres[k * 4 + 1];
          const z = spheres[k * 4 + 2];
          const r = -spheres[k * 4 + 3];
          let inside = true;
          for (let p = 0; p < 6; p++) {
            const pl = planes[p];
            if (pl.normal.x * x + pl.normal.y * y + pl.normal.z * z + pl.constant < r) {
              inside = false;
              break;
            }
          }
          if (!inside) continue;
          const id = c.serial * 1024 + k;
          if (ids[n] !== id) {
            ids[n] = id;
            changed = true;
          }
          if (changed) {
            const o = n * 16;
            for (let e = 0; e < 16; e++) out[o + e] = matrices[k * 16 + e];
            out[o + 12] += dx;
            out[o + 14] += dz;
          }
          n++;
        }
      }
      if (n !== batch.count) changed = true;
      if (changed) {
        batch.count = n;
        ids.length = n;
        mesh.position.set(originX, 0, originZ);
        mesh.count = n;
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, n * 16);
        mesh.instanceMatrix.needsUpdate = true;
      }
      mesh.visible = n > 0;
    }
  }

  /** How far round the walker the forest is kept loaded, in metres. */
  get radius(): number {
    return this.viewRadius;
  }

  /**
   * Whether the forest at a point is loaded, and `margin` metres round it: only there is
   * it known what stands on the ground.
   */
  loaded(x: number, z: number, margin = 0): boolean {
    for (let cx = Math.floor((x - margin) / CHUNK); cx <= Math.floor((x + margin) / CHUNK); cx++) {
      for (let cz = Math.floor((z - margin) / CHUNK); cz <= Math.floor((z + margin) / CHUNK); cz++) {
        if (!this.chunks.has(keyOf(cx, cz))) return false;
      }
    }
    return true;
  }

  /**
   * While loading, with `on`: every kind of tree is drawn once, in view or not, so the frame
   * drawn then sends all their shapes to the graphics card and none is left for later.
   * Call it again with `on` false after that frame.
   */
  stage(on: boolean): void {
    for (const batch of this.batches) {
      batch.mesh.count = on ? Math.max(batch.count, 1) : batch.count;
      batch.mesh.visible = on || batch.count > 0;
    }
  }

  /** Synchronously fills the whole view radius (used while loading). */
  fill(x: number, z: number): void {
    for (const [cx, cz] of this.needed(x, z)) if (!this.chunks.has(keyOf(cx, cz))) this.build(cx, cz);
  }

  /**
   * Builds at most one missing chunk per frame (nearest first). Chunks are needed
   * ~90 m ahead of a walker doing at most ~6 m/s, so this never falls behind and
   * avoids two builds landing in the same frame.
   */
  update(x: number, z: number, budget = 1): void {
    const needed = this.needed(x, z);
    const inView = this.inView;
    inView.length = 0;
    let built = 0;
    for (const [cx, cz] of needed) {
      let chunk = this.chunks.get(keyOf(cx, cz));
      if (!chunk && built < budget) {
        chunk = this.build(cx, cz);
        built++;
      }
      if (chunk) inView.push(chunk);
    }
    for (const chunk of this.chunks.values()) chunk.group.visible = false;
    for (const chunk of inView) chunk.group.visible = true;
    const drop = (this.viewRadius + CHUNK * 1.5) ** 2;
    for (const chunk of this.chunks.values()) {
      if (chunk.group.visible) continue;
      const dx = (chunk.cx + 0.5) * CHUNK - x;
      const dz = (chunk.cz + 0.5) * CHUNK - z;
      if (dx * dx + dz * dz > drop) this.dispose(chunk);
    }
  }

  collidersNear(x: number, z: number, out: Collider[]): Collider[] {
    out.length = 0;
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const chunk = this.chunks.get(keyOf(cx + i, cz + j));
        if (chunk) for (const c of chunk.colliders) out.push(c);
      }
    }
    this.pushExtras(cx * CHUNK - CHUNK, cz * CHUNK - CHUNK, cx * CHUNK + 2 * CHUNK, cz * CHUNK + 2 * CHUNK, out);
    return out;
  }

  /** Adds colliders for something placed in the world; they stay until clearProps(). */
  addColliders(colliders: Collider[]): void {
    this.extras.push(...colliders);
  }

  /**
   * Keeps a circle free of trees, drifts and fallen trunks, rebuilding the chunks
   * already loaded there (call it only for a spot the fog hides). If `level` is given,
   * the snowfield is also levelled flat at `level.y` within `level.flat` metres,
   * blending smoothly back into the surrounding snow by `r`.
   */
  clear(x: number, z: number, r: number, level?: { y: number; flat: number }): void {
    this.clearings.push({ x, z, r, levelled: level !== undefined });
    if (level) this.height.level(x, z, level.y, level.flat, r);
    for (const chunk of [...this.chunks.values()]) {
      const nx = Math.max(chunk.cx * CHUNK, Math.min(x, (chunk.cx + 1) * CHUNK));
      const nz = Math.max(chunk.cz * CHUNK, Math.min(z, (chunk.cz + 1) * CHUNK));
      const d2 = (nx - x) ** 2 + (nz - z) ** 2;
      if (d2 > (r + 10) ** 2) continue;
      if (level && d2 <= (r + 1) ** 2) this.rebuildTerrain(chunk);
      this.populate(chunk);
    }
  }

  removeColliders(colliders: Collider[]): void {
    const gone = new Set(colliders);
    this.extras = this.extras.filter((c) => !gone.has(c));
  }

  /** Forgets everything placed from outside: extra colliders, clearings and levelled ground. */
  clearProps(): void {
    const old = this.clearings.length ? this.clearings.slice() : null;
    this.extras.length = 0;
    this.clearings.length = 0;
    this.height.resetLevels();
    if (!old) return;
    const dirtyProps = new Set<Chunk>();
    const dirtyTerrain = new Set<Chunk>();
    for (const c of old) {
      for (const chunk of this.chunks.values()) {
        const nx = Math.max(chunk.cx * CHUNK, Math.min(c.x, (chunk.cx + 1) * CHUNK));
        const nz = Math.max(chunk.cz * CHUNK, Math.min(c.z, (chunk.cz + 1) * CHUNK));
        const d2 = (nx - c.x) ** 2 + (nz - c.z) ** 2;
        if (d2 <= (c.r + 10) ** 2) dirtyProps.add(chunk);
        if (c.levelled && d2 <= (c.r + 1) ** 2) dirtyTerrain.add(chunk);
      }
    }
    for (const chunk of dirtyTerrain) this.rebuildTerrain(chunk);
    for (const chunk of dirtyProps) this.populate(chunk);
  }

  private rebuildTerrain(chunk: Chunk): void {
    const ox = chunk.cx * CHUNK;
    const oz = chunk.cz * CHUNK;
    chunk.terrain.geometry.dispose();
    chunk.terrain.geometry = buildTerrainGeometry(this.height, ox, oz, CHUNK, SEGMENTS);
  }

  private pushExtras(minX: number, minZ: number, maxX: number, maxZ: number, out: Collider[]): void {
    for (const c of this.extras) {
      if (c.x + c.r >= minX && c.x - c.r <= maxX && c.z + c.r >= minZ && c.z - c.r <= maxZ) out.push(c);
    }
  }

  private cleared(x: number, z: number, margin: number): boolean {
    for (const c of this.clearings) {
      const r = c.r + margin;
      if ((x - c.x) ** 2 + (z - c.z) ** 2 < r * r) return true;
    }
    return false;
  }

  /** Every collider of the loaded chunks overlapping a rectangle. */
  collidersIn(minX: number, minZ: number, maxX: number, maxZ: number, out: Collider[]): Collider[] {
    out.length = 0;
    for (let cx = Math.floor(minX / CHUNK); cx <= Math.floor(maxX / CHUNK); cx++) {
      for (let cz = Math.floor(minZ / CHUNK); cz <= Math.floor(maxZ / CHUNK); cz++) {
        const chunk = this.chunks.get(keyOf(cx, cz));
        if (chunk) for (const c of chunk.colliders) out.push(c);
      }
    }
    this.pushExtras(minX, minZ, maxX, maxZ, out);
    return out;
  }

  private needed(x: number, z: number): [number, number][] {
    const list: [number, number, number][] = [];
    const r = Math.ceil(this.viewRadius / CHUNK) + 1;
    const pcx = Math.floor(x / CHUNK);
    const pcz = Math.floor(z / CHUNK);
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const cx = pcx + i;
        const cz = pcz + j;
        const nx = Math.max(cx * CHUNK, Math.min(x, (cx + 1) * CHUNK));
        const nz = Math.max(cz * CHUNK, Math.min(z, (cz + 1) * CHUNK));
        const d = Math.hypot(nx - x, nz - z);
        if (d <= this.viewRadius) list.push([cx, cz, d]);
      }
    }
    list.sort((a, b) => a[2] - b[2]);
    return list.map(([cx, cz]) => [cx, cz]);
  }

  /** Any one variant of a kind. */
  private oneOf(rand: () => number, kind: TreeKind): number {
    const list = this.kinds.get(kind)!;
    return list[Math.floor(rand() * list.length)];
  }

  /** Picks a kind from a weighted species mix. */
  private pickKind(rand: () => number, mix: Mix): TreeKind {
    let r = rand();
    for (const [kind, share] of mix) {
      if (r < share) return kind;
      r -= share;
    }
    return mix[0][0];
  }

  /**
   * Relief-driven Siberian taiga biotope at (x, z):
   * frozen creek hollows -> bog; open glades & stepped edges -> clearing;
   * high dry hills -> pineRidge; forest edges & patch openings -> birchGrove;
   * otherwise -> darkTaiga (West/South Siberian fir-spruce-cedar dominance).
   */
  private biotopeAt(x: number, z: number, forest: number, hollow: number): Biotope {
    if (hollow > 0.14) return "bog";
    if (forest < 0.28) return "clearing";
    const elev = this.hills(x, z);
    const macro = this.stand(x * 0.0022, z * 0.0022);
    if (elev > 2.8 - macro * 1.2 && hollow < 0.05) return "pineRidge";
    const p = this.patch(x * 0.0075, z * 0.0075);
    if ((forest < 0.48 && p < -0.08) || p < -0.38 + macro * 0.16) return "birchGrove";
    return "darkTaiga";
  }

  /** The height the snow is drawn at here (its flat triangles, not the smooth field they are made from). */
  snowAt(x: number, z: number): number {
    return drawnHeight(this.height, x, z, CHUNK / SEGMENTS);
  }

  /** How deep in the forest a spot is, 0 (open snow) to 1. */
  forest(x: number, z: number): number {
    return smoothstep(-0.45, 0.5, this.density(x * 0.011, z * 0.011) + 0.4 * this.detail(x * 0.045, z * 0.045));
  }

  private build(cx: number, cz: number): Chunk {
    const ox = cx * CHUNK;
    const oz = cz * CHUNK;
    const group = new THREE.Group();
    group.position.set(ox, 0, oz);
    const terrain = new THREE.Mesh(buildTerrainGeometry(this.height, ox, oz, CHUNK, SEGMENTS), this.snowMaterial);
    group.add(terrain);
    this.group.add(group);
    const chunk: Chunk = { key: keyOf(cx, cz), cx, cz, group, terrain, logs: [], colliders: [], stands: [], bounds: new THREE.Box3(), serial: 0 };
    this.populate(chunk);
    this.chunks.set(chunk.key, chunk);
    return chunk;
  }

  /**
   * Places everything in a chunk in 4 ecological layers:
   * 1) Layer-1 canopy dominants with species-specific crown inhibition & passability clearance.
   * 2) Coupled windthrow micro-scenes (wind-aligned fallen logs + snapped stumps/snags + gap regeneration).
   * 3) Layer-2 shade-tolerant conifer understory (under birch/aspen groves and dark taiga gaps).
   * 4) Shrubs, creekside willow thickets, boulders, snow mounds, dry grass and standalone deadwood.
   */
  private populate(chunk: Chunk): void {
    const { cx, cz, group } = chunk;
    const ox = cx * CHUNK;
    const oz = cz * CHUNK;
    for (const mesh of chunk.logs) {
      group.remove(mesh);
      mesh.geometry.dispose();
    }
    chunk.logs = [];

    const perVariant: number[][] = this.variants.map(() => []);
    const colliders: Collider[] = [];
    // Tracks placed trunks/boulders BEFORE clearing checks, so clearing a hut/sign spot never shifts neighbors.
    const placed: { x: number; z: number; inhibit: number; walk: number }[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();

    const fits = (wx: number, wz: number, inhibit: number, walk: number, ignoreInhibit = false): boolean => {
      if (wx * wx + wz * wz < SPAWN_CLEAR * SPAWN_CLEAR) return false;
      for (let i = 0; i < placed.length; i++) {
        const o = placed[i];
        const dx = wx - o.x;
        const dz = wz - o.z;
        const d2 = dx * dx + dz * dz;
        const minR = ignoreInhibit ? 0 : Math.max(o.inhibit, inhibit);
        const passR = walk > 0 && o.walk > 0 ? walk + o.walk + MIN_PASS_GAP : 0;
        const req = Math.max(minR, passR);
        if (req > 0 && d2 < req * req) return false;
      }
      return true;
    };

    const emit = (
      rand: () => number,
      vi: number,
      wx: number,
      wz: number,
      scale: number,
      forcedYaw?: number,
      record = true
    ): void => {
      const v = this.variants[vi];
      const place = PLACE[v.kind];
      const y = this.height(wx, wz) - (place.sink[0] + rand() * (place.sink[1] - place.sink[0])) * (v.kind === "rock" ? scale : 1);
      const yaw =
        forcedYaw !== undefined
          ? forcedYaw
          : v.flagged
            ? this.wind + (rand() - 0.5) * 0.7
            : rand() * Math.PI * 2;
      e.set((rand() - 0.5) * place.tilt, yaw, (rand() - 0.5) * place.tilt);
      const climbable = v.climb !== undefined && v.climb.top * scale <= MAX_CLIMB;
      const walk = v.radius > 0 && !climbable ? v.walkRadius * scale : 0;
      if (record && (place.inhibit > 0 || walk > 0)) {
        placed.push({ x: wx, z: wz, inhibit: place.inhibit * scale, walk });
      }
      // Left out only now, after deterministic draws and placement tracking: clearing moves nothing around it.
      if (this.clearings.length && this.cleared(wx, wz, 0)) return;
      q.setFromEuler(e);
      s.setScalar(scale);
      p.set(wx - ox, y, wz - oz);
      m.compose(p, q, s);
      perVariant[vi].push(...m.elements);
      if (v.radius <= 0) return;
      colliders.push({
        x: wx,
        z: wz,
        r: v.radius * scale,
        walk,
        mound: climbable ? { y, h: v.climb!.top * scale, reach: v.climb!.reach * scale } : undefined,
        footprint: v.climb ? v.climb.reach * scale : v.kind === "rock" ? v.radius * scale : undefined
      });
    };

    const drawScale = (rand: () => number, kind: TreeKind, mul = 1): number => {
      const [lo, hi] = PLACE[kind].scale;
      return (lo + rand() * (hi - lo)) * mul;
    };

    const cells = CHUNK / CELL;

    // Pass 1: Layer-1 canopy dominants with relief-driven biotopes and crown competition.
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        const gx = cx * cells + i;
        const gz = cz * cells + j;
        const rand = mulberry32(hash3(gx, gz, 7, this.seed));
        const wx0 = gx * CELL;
        const wz0 = gz * CELL;
        const forest = this.forest(wx0 + CELL * 0.5, wz0 + CELL * 0.5);
        const hollow = this.hollows(wx0 + CELL * 0.5, wz0 + CELL * 0.5);
        const dry = 1 - smoothstep(0.14, 0.45, hollow);
        if (dry <= 0.05) continue;

        const bio = this.biotopeAt(wx0 + CELL * 0.5, wz0 + CELL * 0.5, forest, hollow);
        // Inner open clearing: keep snowfield clean; outer mantle steps up gradually.
        if (bio === "clearing" && forest < 0.14) continue;

        let attempts = 0;
        if (bio === "darkTaiga") {
          const p1 = (0.45 + forest * 0.48) * dry;
          if (rand() < p1) attempts = rand() < forest * 0.5 ? 2 : 1;
        } else if (bio === "pineRidge") {
          if (rand() < (0.3 + forest * 0.34) * dry) attempts = 1;
        } else if (bio === "birchGrove") {
          if (rand() < (0.32 + forest * 0.38) * dry) attempts = 1;
        } else if (bio === "bog") {
          if (rand() < 0.24 * dry) attempts = 1;
        } else {
          // Stepped forest mantle (0.14 <= forest < 0.28).
          const mantle = smoothstep(0.14, 0.28, forest);
          if (rand() < mantle * 0.34 * dry) attempts = 1;
        }

        for (let a = 0; a < attempts; a++) {
          const wx = wx0 + rand() * CELL;
          const wz = wz0 + rand() * CELL;
          let kind = this.pickKind(rand, BIOTOPE_MIX[bio]);
          // Outer clearing edge stays low (young / subSpruce) before stepping up to birch/aspen.
          if (bio === "clearing" && forest < 0.21 && kind !== "young" && kind !== "subSpruce") {
            kind = rand() < 0.65 ? "young" : "subSpruce";
          }
          const vi = this.oneOf(rand, kind);
          const v = this.variants[vi];
          const scaleMul = bio === "bog" ? 0.72 : bio === "clearing" ? 0.86 : 1;
          const scale = drawScale(rand, kind, scaleMul);
          if (!fits(wx, wz, PLACE[kind].inhibit * scale, v.walkRadius * scale)) continue;
          emit(rand, vi, wx, wz, scale);
        }
      }
    }

    // Pass 2: Coupled windthrow micro-scenes (fallen trunk aligned to storm wind + snapped stump/snag + gap regeneration).
    const logs = new LogBuilder(this.height, ox, oz, CHUNK, SPAWN_CLEAR + 2);
    for (let t = 0; t < LOG_TRIES; t++) {
      const logRand = mulberry32(hash3(cx, cz, 11 + t, this.seed));
      const wx = ox + logRand() * CHUNK;
      const wz = oz + logRand() * CHUNK;
      const forest = this.forest(wx, wz);
      const hollow = this.hollows(wx, wz);
      const bio = this.biotopeAt(wx, wz, forest, hollow);
      const chance = LOG_CHANCE[bio] * (0.4 + 0.6 * forest);
      if (logRand() >= chance) continue;
      if (this.clearings.length && this.cleared(wx, wz, 10)) continue;
      const cross = logRand() < 0.2 ? (logRand() < 0.5 ? 1.3 : -1.3) : 0;
      const fallYaw = this.wind + cross + (logRand() - 0.5) * 0.9;
      const placedLog = logs.add(logRand, wx, wz, colliders, fallYaw);
      if (!placedLog) continue;

      // Coupled snapped stump or snag just behind the butt end when not uprooted.
      if (!placedLog.rooted) {
        const sx = placedLog.ax - placedLog.dx * (0.75 + logRand() * 0.55);
        const sz = placedLog.az - placedLog.dz * (0.75 + logRand() * 0.55);
        const deadKind: TreeKind =
          logRand() < 0.68 ? "stump" : bio === "birchGrove" && logRand() < 0.55 ? "birchSnag" : "snag";
        const vi = this.oneOf(logRand, deadKind);
        const scale = drawScale(logRand, deadKind);
        if (fits(sx, sz, 0.9, this.variants[vi].walkRadius * scale, true)) {
          emit(logRand, vi, sx, sz, scale, undefined, true);
        }
      }

      // Regenerating canopy gap around the fallen log: saplings, shrubs & dry grass.
      const sprouts = 1 + Math.floor(logRand() * 3);
      for (let sIdx = 0; sIdx < sprouts; sIdx++) {
        const u = logRand();
        const side = logRand() < 0.5 ? -1 : 1;
        const dist = 1.2 + logRand() * 2.8;
        const gx = placedLog.ax + (placedLog.bx - placedLog.ax) * u - placedLog.dz * side * dist;
        const gz = placedLog.az + (placedLog.bz - placedLog.az) * u + placedLog.dx * side * dist;
        if (gx < ox + 0.5 || gx > ox + CHUNK - 0.5 || gz < oz + 0.5 || gz > oz + CHUNK - 0.5) continue;
        const gKind: TreeKind = logRand() < 0.45 ? "young" : logRand() < 0.78 ? "bush" : "grass";
        const vi = this.oneOf(logRand, gKind);
        const scale = drawScale(logRand, gKind);
        if (gKind !== "young" || fits(gx, gz, PLACE.young.inhibit * scale, this.variants[vi].walkRadius * scale)) {
          emit(logRand, vi, gx, gz, scale, undefined, gKind === "young");
        }
      }
    }
    if (!logs.empty) {
      chunk.logs = [new THREE.Mesh(logs.bark.build(), this.treeMaterial), new THREE.Mesh(logs.buildSnow(), this.snowMaterial)];
      group.add(...chunk.logs);
    }

    // Pass 3: Layer-2 shade-tolerant conifer understory (under birch/aspen canopies & dark taiga gaps).
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        const gx = cx * cells + i;
        const gz = cz * cells + j;
        const rand = mulberry32(hash3(gx, gz, 19, this.seed));
        const wx0 = gx * CELL;
        const wz0 = gz * CELL;
        const forest = this.forest(wx0 + CELL * 0.5, wz0 + CELL * 0.5);
        const hollow = this.hollows(wx0 + CELL * 0.5, wz0 + CELL * 0.5);
        const dry = 1 - smoothstep(0.14, 0.45, hollow);
        if (dry <= 0.1 || forest < 0.25) continue;

        const bio = this.biotopeAt(wx0 + CELL * 0.5, wz0 + CELL * 0.5, forest, hollow);
        const chance =
          bio === "birchGrove"
            ? 0.3 * forest * dry
            : bio === "darkTaiga"
              ? 0.2 * forest * dry
              : bio === "pineRidge"
                ? 0.05 * forest * dry
                : 0;
        if (rand() >= chance) continue;

        const wx = wx0 + rand() * CELL;
        const wz = wz0 + rand() * CELL;
        const kind: TreeKind = rand() < (bio === "birchGrove" ? 0.62 : 0.48) ? "subSpruce" : "young";
        const vi = this.oneOf(rand, kind);
        const v = this.variants[vi];
        const scale = drawScale(rand, kind);
        if (!fits(wx, wz, PLACE[kind].inhibit * scale, v.walkRadius * scale)) continue;
        emit(rand, vi, wx, wz, scale);
      }
    }

    // Pass 4: Shrubs, creekside willow thickets, boulders, snow mounds, dry grass & standalone deadwood.
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        const gx = cx * cells + i;
        const gz = cz * cells + j;
        const rand = mulberry32(hash3(gx, gz, 29, this.seed));
        const wx0 = gx * CELL;
        const wz0 = gz * CELL;
        const forest = this.forest(wx0 + CELL * 0.5, wz0 + CELL * 0.5);
        const hollow = this.hollows(wx0 + CELL * 0.5, wz0 + CELL * 0.5);
        const dry = 1 - smoothstep(0.12, 0.45, hollow);
        const bank = smoothstep(0.03, 0.22, hollow) * (1 - smoothstep(0.5, 0.85, hollow));
        const bio = this.biotopeAt(wx0 + CELL * 0.5, wz0 + CELL * 0.5, forest, hollow);

        const picks: TreeKind[] = [];
        if (rand() < 0.055 * dry) picks.push("mound");
        const rockChance = bio === "pineRidge" ? 0.048 : bio === "clearing" ? 0.026 : 0.01;
        if (rand() < rockChance) picks.push("rock");
        const deadChance = bio === "darkTaiga" ? 0.045 * dry : bio === "birchGrove" ? 0.03 * dry : 0.008 * dry;
        if (rand() < deadChance) {
          picks.push(rand() < 0.58 ? "stump" : bio === "birchGrove" && rand() < 0.55 ? "birchSnag" : "snag");
        }
        if (rand() < bank * 0.34 + (bio === "clearing" && forest > 0.14 ? 0.05 : 0)) picks.push("tallBush");
        if (rand() < 0.015 + bank * 0.24 + (bio === "birchGrove" ? 0.04 : 0)) picks.push("bush");
        if (rand() < 0.025 + (1 - forest) * 0.075 + hollow * 0.38 + (bio === "birchGrove" ? 0.03 : 0)) picks.push("grass");

        for (const kind of picks) {
          const wx = wx0 + rand() * CELL;
          const wz = wz0 + rand() * CELL;
          const vi = this.oneOf(rand, kind);
          const v = this.variants[vi];
          const scale = drawScale(rand, kind);
          const solid = v.radius > 0 && !(v.climb !== undefined && v.climb.top * scale <= MAX_CLIMB);
          if (solid && !fits(wx, wz, PLACE[kind].inhibit * scale, v.walkRadius * scale)) continue;
          if (!solid && wx * wx + wz * wz < SPAWN_CLEAR * SPAWN_CLEAR) continue;
          emit(rand, vi, wx, wz, scale, undefined, solid);
        }
      }
    }

    const bounds = chunk.bounds.makeEmpty();
    const sphere = new THREE.Sphere();
    chunk.stands = perVariant.map((list, vi) => {
      if (list.length === 0) return null;
      const matrices = new Float32Array(list);
      const count = list.length / 16;
      const spheres = new Float64Array(count * 4);
      const own = this.variants[vi].geometry.boundingSphere!;
      for (let k = 0; k < count; k++) {
        m.fromArray(list, k * 16);
        sphere.copy(own).applyMatrix4(m);
        sphere.center.x += ox;
        sphere.center.z += oz;
        sphere.radius += 2; // headroom for wind sway
        spheres[k * 4] = sphere.center.x;
        spheres[k * 4 + 1] = sphere.center.y;
        spheres[k * 4 + 2] = sphere.center.z;
        spheres[k * 4 + 3] = sphere.radius;
        bounds.expandByPoint(p.copy(sphere.center).addScalar(sphere.radius));
        bounds.expandByPoint(p.copy(sphere.center).addScalar(-sphere.radius));
      }
      return { matrices, spheres };
    });
    chunk.colliders = colliders;
    chunk.serial = ++this.serial;
  }

  private dispose(chunk: Chunk): void {
    this.group.remove(chunk.group);
    for (const child of chunk.group.children) if (child instanceof THREE.Mesh) child.geometry.dispose();
    this.chunks.delete(chunk.key);
  }
}
