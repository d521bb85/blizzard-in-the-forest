import * as THREE from "three";
import { injectBlizzardFog } from "../render/fog";
import { injectRetro, SNOW_TEXELS } from "../render/retro";
import { createSimplex2, hash3, mulberry32, smoothstep } from "../lib/noise";
import { buildTerrainGeometry, createHollows, drawnHeight, type HeightField } from "./terrain";
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
/** Places per chunk where a fallen trunk may lie, and the chance of one in open ground and in deep forest. */
const LOG_TRIES = 3;
const LOG_OPEN = 0.05;
const LOG_FOREST = 0.3;
/** Texels per metre of the "texture" on trees and everything else of wood and stone. */
const BARK_TEXELS = 14;

/** How each kind of thing stands in the snow: its range of sizes, how deep it is sunk, how far it may lean. */
const PLACE: Record<TreeKind, { scale: [number, number]; sink: [number, number]; tilt: number }> = {
  spruce: { scale: [0.75, 1.25], sink: [0.25, 0.55], tilt: 0.045 },
  young: { scale: [0.75, 1.25], sink: [0.25, 0.55], tilt: 0.045 },
  pine: { scale: [0.8, 1.2], sink: [0.25, 0.55], tilt: 0.05 },
  birch: { scale: [0.75, 1.2], sink: [0.2, 0.45], tilt: 0.1 },
  bare: { scale: [0.75, 1.25], sink: [0.25, 0.55], tilt: 0.045 },
  snag: { scale: [0.75, 1.25], sink: [0.25, 0.55], tilt: 0.12 },
  mound: { scale: [0.6, 1.5], sink: [0, 0], tilt: 0 },
  bush: { scale: [0.7, 1.3], sink: [0, 0.15], tilt: 0.1 },
  grass: { scale: [0.7, 1.3], sink: [0, 0.1], tilt: 0.1 },
  stump: { scale: [0.8, 1.25], sink: [0.05, 0.25], tilt: 0.08 },
  rock: { scale: [0.7, 1.4], sink: [0.05, 0.3], tilt: 0.25 }
};

/** What grows where: the share of each kind among the trees of a stand. */
type Mix = [TreeKind, number][];
const STANDS: { spruce: Mix; pine: Mix; birch: Mix; open: Mix } = {
  spruce: [["spruce", 0.72], ["young", 0.11], ["snag", 0.06], ["birch", 0.04], ["pine", 0.04], ["bare", 0.03]],
  pine: [["pine", 0.56], ["spruce", 0.14], ["young", 0.12], ["birch", 0.08], ["snag", 0.06], ["bare", 0.04]],
  birch: [["birch", 0.5], ["spruce", 0.18], ["young", 0.12], ["bare", 0.12], ["snag", 0.05], ["pine", 0.03]],
  open: [["young", 0.28], ["spruce", 0.2], ["birch", 0.16], ["bare", 0.12], ["pine", 0.08], ["mound", 0.1], ["snag", 0.06]]
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

/** The colours of a cold, overcast winter forest. Snow is white in the light and only a little cool in shade. */
const SNOW_LIGHT = tint(0.98, 0.99, 1.0);
const SNOW_SHADE = tint(0.93, 0.95, 0.98);
const BARK_BROWN = tint(0.46, 0.29, 0.17);
const NEEDLE_GREEN = tint(0.1, 0.3, 0.14);
const STONE = tint(0.47, 0.49, 0.54);
const STRAW = tint(0.72, 0.56, 0.24);
const PLANK = tint(0.56, 0.38, 0.22);
const BIRCH_MARK = tint(0.3, 0.27, 0.25);
const BIRCH_PALE = tint(1.0, 0.96, 0.88);

export function createSnowMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    injectBlizzardFog(shader);
    injectRetro(shader, { affine: "vBzWorld.xz", worldSpace: true });
    // Fine surface variation: wind ripples and soft patches give motion cues. It reads
    // like a low-resolution texture: blocky texels, warped across each triangle.
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
        // In colour the darker patches and ripples turn a little bluer.
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
        varying vec3 vHue;
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
          return mix(${BIRCH_MARK}, ${BIRCH_PALE}, smoothstep(0.4, 0.7, gray));
        }`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
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
          transformed += localWind * sway * h * h * 0.0016;
        }
        #endif
        vHue = hueOf(matter, pow(color.r, 1.0 / 2.2));`
      );
    injectRetro(shader, { affine3: "position" });
    // A coarse "texture" that sticks to the model: blocky texels, stretched along
    // the trunk like bark, strong on dark wood and needles and faint on snow.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      {
        vec3 t = retroAffine3() * ${BARK_TEXELS.toFixed(1)};
        vec3 cell = floor(vec3(t.x, t.y * 0.4, t.z));
        float fine = bzHash(cell);
        float coarse = bzHash(floor(cell * vec3(0.5, 0.25, 0.5)) + 31.0);
        float amp = mix(0.6, 0.1, smoothstep(0.02, 0.4, diffuseColor.r));
        diffuseColor.rgb *= 1.0 + amp * (fine * 1.3 + coarse * 0.7 - 1.0);
        // Dark wood and needles are lifted out of the black, or their colour would not show.
        float lift = mix(${COLOUR_LIFT.toFixed(1)}, 1.0, smoothstep(0.0, 0.3, diffuseColor.r));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vHue * lift, uColour);
      }`
    ).replace("#include <common>", "#include <common>\nvarying vec3 vHue;");
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
  private hollows;
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
    this.hollows = createHollows(seed);
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
        // Grows now and then as more of a kind comes into view; never shrinks.
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
      // From the first slot whose tree differs from last time, every slot is written.
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
      // Slots before the first change still hold what was uploaded last time.
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
    // Chunks that left the view radius stop drawing right away, and are
    // forgotten once well behind so memory stays bounded.
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
      // Only chunks whose vertices or normals touch the blend ring need their snowfield rebuilt.
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
        // Distance from the walker to the nearest point of the chunk.
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

  /**
   * A tree for a spot. Deep forest is spruce for the most part, with stands of
   * pine and groves of birch in it; open ground gets a bit of everything.
   */
  private pickVariant(rand: () => number, forest: number, x: number, z: number): number {
    let mix = STANDS.open;
    if (forest > 0.35) {
      const s = this.stand(x * 0.006, z * 0.006);
      const r = rand();
      mix = r < smoothstep(0.1, 0.45, s) ? STANDS.pine : r < smoothstep(-0.15, -0.5, s) ? STANDS.birch : STANDS.spruce;
    }
    let r = rand();
    for (const [kind, share] of mix) {
      if (r < share) return this.oneOf(rand, kind);
      r -= share;
    }
    return this.oneOf(rand, mix[0][0]);
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

  /** Places (or places again) everything that stands in a chunk: trees, drifts, rocks, fallen trunks. */
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
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const cells = CHUNK / CELL;
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        const gx = cx * cells + i;
        const gz = cz * cells + j;
        const rand = mulberry32(hash3(gx, gz, 7, this.seed));
        const wx0 = gx * CELL;
        const wz0 = gz * CELL;
        const forest = this.forest(wx0, wz0);
        const hollow = this.hollows(wx0 + CELL / 2, wz0 + CELL / 2);
        // Nothing stands in a stream bed but what grows along its banks.
        const dry = 1 - smoothstep(0.12, 0.45, hollow);
        const bank = smoothstep(0.03, 0.2, hollow) * (1 - smoothstep(0.5, 0.85, hollow));
        const picks: number[] = [];
        const count = rand() < (0.05 + forest * 0.62) * dry ? (rand() < forest * 0.35 ? 2 : 1) : 0;
        for (let n = 0; n < count; n++) picks.push(-1);
        if (rand() < 0.06 * dry) picks.push(this.oneOf(rand, "mound"));
        if (rand() < 0.012 + (1 - forest) * 0.02) picks.push(this.oneOf(rand, "rock"));
        if (rand() < forest * 0.045 * dry) picks.push(this.oneOf(rand, "stump"));
        if (rand() < 0.02 + bank * 0.3) picks.push(this.oneOf(rand, "bush"));
        if (rand() < 0.03 + (1 - forest) * 0.07 + hollow * 0.35) picks.push(this.oneOf(rand, "grass"));

        for (const pick of picks) {
          const wx = wx0 + rand() * CELL;
          const wz = wz0 + rand() * CELL;
          if (wx * wx + wz * wz < SPAWN_CLEAR * SPAWN_CLEAR) continue;
          const vi = pick < 0 ? this.pickVariant(rand, forest, wx, wz) : pick;
          const v = this.variants[vi];
          const place = PLACE[v.kind];
          const scale = place.scale[0] + rand() * (place.scale[1] - place.scale[0]);
          const y = this.height(wx, wz) - (place.sink[0] + rand() * (place.sink[1] - place.sink[0])) * (v.kind === "rock" ? scale : 1);
          e.set((rand() - 0.5) * place.tilt, rand() * Math.PI * 2, (rand() - 0.5) * place.tilt);
          // Left out only now, with its share of the cell's numbers drawn: clearing a spot moves nothing around it.
          if (this.clearings.length && this.cleared(wx, wz, 0)) continue;
          q.setFromEuler(e);
          s.setScalar(scale);
          p.set(wx - ox, y, wz - oz);
          m.compose(p, q, s);
          perVariant[vi].push(...m.elements);
          // Grass and bushes are walked through.
          if (v.radius <= 0) continue;
          const climbable = v.climb !== undefined && v.climb.top * scale <= MAX_CLIMB;
          colliders.push({
            x: wx,
            z: wz,
            r: v.radius * scale,
            walk: climbable ? 0 : v.walkRadius * scale,
            mound: climbable ? { y, h: v.climb!.top * scale, reach: v.climb!.reach * scale } : undefined,
            footprint: v.climb ? v.climb.reach * scale : v.kind === "rock" ? v.radius * scale : undefined
          });
        }
      }
    }

    // Now and then a fallen trunk, more often deep in the forest, wherever it fits between the trees.
    const logs = new LogBuilder(this.height, ox, oz, CHUNK, SPAWN_CLEAR + 2);
    for (let t = 0; t < LOG_TRIES; t++) {
      // Each try draws its own numbers, so one left out of a clearing does not move the others.
      const logRand = mulberry32(hash3(cx, cz, 11 + t, this.seed));
      const wx = ox + logRand() * CHUNK;
      const wz = oz + logRand() * CHUNK;
      const chance = LOG_OPEN + (LOG_FOREST - LOG_OPEN) * this.forest(wx, wz);
      if (logRand() >= chance) continue;
      // A trunk is up to about 16 m long: keep its whole length out of a clearing.
      if (this.clearings.length && this.cleared(wx, wz, 10)) continue;
      logs.add(logRand, wx, wz, colliders);
    }
    if (!logs.empty) {
      chunk.logs = [new THREE.Mesh(logs.bark.build(), this.treeMaterial), new THREE.Mesh(logs.buildSnow(), this.snowMaterial)];
      group.add(...chunk.logs);
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
