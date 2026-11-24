import * as THREE from "three";
import { createSimplex2, fbm, smoothstep, type Noise2 } from "../lib/noise";

export type HeightFn = (x: number, z: number) => number;

/** A levelled clearing in the snowfield: flat within `flat`, blending smoothly out to `blend`. */
interface LevelPad {
  x: number;
  z: number;
  y: number;
  flat: number;
  blend: number;
  flat2: number;
  blend2: number;
}

/** The snowfield's height, with clearings that can be levelled flat under something built on it. */
export interface HeightField extends HeightFn {
  level(x: number, z: number, y: number, flat: number, blend: number): void;
  resetLevels(): void;
}

/** How deep a stream bed lies below the snowfield around it, in metres. */
const HOLLOW_DEPTH = 2.3;

/**
 * Frozen stream beds winding through the forest, and here and there a wider
 * snowed-over bog: 0 away from one, 1 along its middle. They come and go, so no
 * bed runs on for ever.
 */
export function createHollows(seed: number): Noise2 {
  const course = createSimplex2(seed ^ 0x68bc21eb);
  const present = createSimplex2(seed ^ 0x02e5be93);
  return (x, z) => {
    const c = Math.abs(course(x * 0.0035, z * 0.0035));
    if (c >= 0.1) return 0;
    return (1 - smoothstep(0, 0.1, c)) * smoothstep(-0.3, 0.2, present(x * 0.0021, z * 0.0021));
  };
}

/** Infinite rolling snowfield with soft wind-blown drifts, cut by shallow stream beds. */
export function createHeightField(seed: number): HeightField {
  const large = createSimplex2(seed ^ 0x9e3779b9);
  const medium = createSimplex2(seed ^ 0x7f4a7c15);
  const drift = createSimplex2(seed ^ 0x2545f491);
  const hollows = createHollows(seed);
  const pads: LevelPad[] = [];

  const fn = ((x: number, z: number) => {
    const hills = fbm(large, x * 0.0055, z * 0.0055, 4) * 11;
    const swells = medium(x * 0.035, z * 0.035) * 0.8;
    // Elongated drifts: stretched across the prevailing wind.
    const u = x * 0.8 + z * 0.6;
    const v = -x * 0.6 + z * 0.8;
    const drifts = drift(u * 0.11, v * 0.035) * 0.35 + drift(u * 0.4, v * 0.12) * 0.08;
    let h = hills + swells + drifts - hollows(x, z) * HOLLOW_DEPTH;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      const dx = x - p.x;
      const dz = z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= p.blend2) continue;
      if (d2 <= p.flat2) h = p.y;
      else h += (p.y - h) * (1 - smoothstep(p.flat, p.blend, Math.sqrt(d2)));
    }
    return h;
  }) as HeightField;

  fn.level = (x, z, y, flat, blend) => {
    pads.push({ x, z, y, flat, blend, flat2: flat * flat, blend2: blend * blend });
  };
  fn.resetLevels = () => {
    pads.length = 0;
  };
  return fn;
}

export function heightGradient(h: HeightFn, x: number, z: number, out: THREE.Vector2): THREE.Vector2 {
  const e = 0.6;
  out.set((h(x + e, z) - h(x - e, z)) / (2 * e), (h(x, z + e) - h(x, z - e)) / (2 * e));
  return out;
}

/** How far to either side terrainNormal() looks. */
const NORMAL_REACH = 0.5;

/** The snowfield's normal at a point, as the terrain tiles shade it. */
export function terrainNormal(h: HeightFn, x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const e = NORMAL_REACH;
  return out.set(h(x - e, z) - h(x + e, z), 2 * e, h(x, z - e) - h(x, z + e)).normalize();
}

/**
 * The height the snowfield is drawn at here: not the height field itself but the flat
 * triangles buildTerrainGeometry() makes of it, split the same way, on a grid of `step`
 * metres from the world's origin (tiles start on whole, even multiples of it).
 */
export function drawnHeight(h: HeightFn, x: number, z: number, step: number): number {
  const i = Math.floor(x / step);
  const j = Math.floor(z / step);
  const fx = x / step - i;
  const fz = z / step - j;
  const x0 = i * step;
  const z0 = j * step;
  const ha = h(x0, z0);
  const hb = h(x0 + step, z0);
  const hc = h(x0, z0 + step);
  const hd = h(x0 + step, z0 + step);
  if ((i + j) & 1) {
    // Split from (i + 1, j) to (i, j + 1).
    return fx + fz < 1 ? ha + fx * (hb - ha) + fz * (hc - ha) : hd + (1 - fx) * (hc - hd) + (1 - fz) * (hb - hd);
  }
  // Split from (i, j) to (i + 1, j + 1).
  return fz > fx ? ha + fz * (hc - ha) + fx * (hd - hc) : ha + fx * (hb - ha) + fz * (hd - hb);
}

/** Builds a terrain tile in chunk-local coordinates with analytic, seam-free normals. */
export function buildTerrainGeometry(h: HeightFn, ox: number, oz: number, size: number, segments: number): THREE.BufferGeometry {
  const n = segments + 1;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const step = size / segments;
  const normal = new THREE.Vector3();
  const e = NORMAL_REACH;
  // When vertices are two reaches apart, the point a vertex's normal looks at on one
  // side is the one its neighbour looks at on the other: each is sampled only once.
  // midX[j * (n + 1) + i] is half a step before vertex i of row j; midZ likewise along z.
  const shared = step === 2 * e;
  const midX = shared ? new Float64Array((n + 1) * n) : null;
  const midZ = shared ? new Float64Array(n * (n + 1)) : null;
  if (midX && midZ) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i <= n; i++) {
        midX[j * (n + 1) + i] = h(ox + i * step - e, oz + j * step);
        midZ[j * (n + 1) + i] = h(ox + j * step, oz + i * step - e);
      }
    }
  }
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const lx = i * step;
      const lz = j * step;
      const wx = ox + lx;
      const wz = oz + lz;
      positions[k] = lx;
      positions[k + 1] = h(wx, wz);
      positions[k + 2] = lz;
      if (midX && midZ) {
        const row = j * (n + 1) + i;
        const col = i * (n + 1) + j;
        normal.set(midX[row] - midX[row + 1], 2 * e, midZ[col] - midZ[col + 1]).normalize();
      } else terrainNormal(h, wx, wz, normal);
      normals[k] = normal.x;
      normals[k + 1] = normal.y;
      normals[k + 2] = normal.z;
      k += 3;
    }
  }
  const indices = new Uint16Array(segments * segments * 6);
  let t = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      if ((i + j) & 1) {
        indices.set([a, c, b, b, c, d], t);
      } else {
        indices.set([a, c, d, a, d, b], t);
      }
      t += 6;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}
