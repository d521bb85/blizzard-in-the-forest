import * as THREE from "three";
import { mulberry32 } from "../lib/noise";
import { GeoBuilder, MATTER, TAU } from "../world/trees";
import type { Collider } from "../world/collider";

/** A square cabin: width (local X) and depth (local Z), out to the centre lines of the logs. */
const W = 3.6;
const D = 3.6;
const LOG_R = 0.15;
/** One course of logs: each wall's logs sit half a course above or below the next wall's. */
const COURSE = 0.27;
const COURSES = 8;
const WALL = COURSES * COURSE;
/** Log ends stick out past the corners by this much, as they do on a cabin notched "in the bowl". */
const LAP = 0.28;
/** A steep roof, its ridge running front to back, so the front is a gable. */
const RIDGE = 1.6;
/** How far the roof reaches out past the side walls, and past the front and back gables. */
const EAVE = 0.5;
const GABLE = 0.5;
/** The door, on the left of the front: its middle, width and height. */
const DOOR_X = -0.75;
const DOOR_W = 0.85;
const DOOR_H = 1.75;
const DOOR_L = DOOR_X - DOOR_W / 2;
const DOOR_R = DOOR_X + DOOR_W / 2;
/** The window, on the right of the front: its middle, sill and top. */
const WIN_X = 0.85;
const WIN_W = 0.6;
const WIN_LO = 0.95;
const WIN_HI = 1.45;
/** How far the door stands open to begin with, and once pushed (about half way). */
const AJAR = 0.45;
const OPEN = 1.05;
const SNOW = 0.92;
const WOOD = 0.36;
/** Window frame and shutters: planed boards, paler than the logs. */
const TRIM = 0.72;

type Rand = () => number;
type V = THREE.Vector3;
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A log between two points: six-sided, weathered grey, dusted with snow on top. */
function log(b: GeoBuilder, rand: Rand, a: V, c: V, r: number, snow: number): void {
  const dir = new THREE.Vector3().subVectors(c, a).normalize();
  const helper = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(dir, helper).normalize();
  const w = new THREE.Vector3().crossVectors(dir, u).normalize();
  const sides = 6;
  const tone = WOOD * (0.8 + rand() * 0.4);
  const ring0: number[] = [];
  const ring1: number[] = [];
  const radial = new THREE.Vector3();
  const off = rand() * TAU;
  for (let i = 0; i < sides; i++) {
    const t = off + (i / sides) * TAU;
    radial.copy(u).multiplyScalar(Math.cos(t)).addScaledVector(w, Math.sin(t));
    const rr = r * (0.92 + rand() * 0.14);
    const g = radial.y > 0.6 && rand() < snow ? SNOW * (0.9 + rand() * 0.1) : tone * (0.85 + rand() * 0.3);
    ring0.push(b.vertex(a.x + radial.x * rr, a.y + radial.y * rr, a.z + radial.z * rr, g));
    ring1.push(b.vertex(c.x + radial.x * rr, c.y + radial.y * rr, c.z + radial.z * rr, g));
  }
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    b.tri(ring0[i], ring1[i], ring1[j]);
    b.tri(ring0[i], ring1[j], ring0[j]);
  }
  // Sawn ends, paler than the bark.
  const end = (ring: number[], at: V, flip: boolean) => {
    const mid = b.vertex(at.x, at.y, at.z, 0.46);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      if (flip) b.tri(mid, ring[j], ring[i]);
      else b.tri(mid, ring[i], ring[j]);
    }
  };
  end(ring0, a, false);
  end(ring1, c, true);
}

/** A quad from four corners, in order round its edge. */
function quad(b: GeoBuilder, p: V[], gray: number): void {
  const i = p.map((q) => b.vertex(q.x, q.y, q.z, gray));
  b.tri(i[0], i[1], i[2]);
  b.tri(i[0], i[2], i[3]);
}

/** A box from a corner and its three edges; `top` is the grey of the face at the far end of the second edge. */
function cuboid(b: GeoBuilder, o: V, ex: V, ey: V, ez: V, gray: number, top = gray): void {
  const p = (x: number, y: number, z: number) => o.clone().addScaledVector(ex, x).addScaledVector(ey, y).addScaledVector(ez, z);
  quad(b, [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)], top);
  quad(b, [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)], gray);
  quad(b, [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)], gray);
  quad(b, [p(1, 0, 0), p(0, 0, 0), p(0, 1, 0), p(1, 1, 0)], gray);
  quad(b, [p(1, 0, 1), p(1, 0, 0), p(1, 1, 0), p(1, 1, 1)], gray);
  quad(b, [p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)], gray);
}

/** An axis-aligned box by its two corners. */
function block(b: GeoBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, gray: number, top = gray): void {
  cuboid(b, v(x0, y0, z0), v(x1 - x0, 0, 0), v(0, y1 - y0, 0), v(0, 0, z1 - z0), gray, top);
}

/** A flat board along a line from a to c, hanging `width` towards `down`, `thick` deep along Z. */
function board(b: GeoBuilder, a: V, c: V, down: V, width: number, thick: number, gray: number): void {
  cuboid(b, a.clone().addScaledVector(down, width), c.clone().sub(a), down.clone().multiplyScalar(-width), v(0, 0, thick), gray, gray);
}

/**
 * A heap of snow: a low dome stretched along a direction, its surface left lumpy.
 * (x, z) is its middle, len and width its half-extents, h its height.
 */
function heap(b: GeoBuilder, rand: Rand, x: number, z: number, y: number, len: number, width: number, h: number, alongX: boolean): void {
  const rings = 4;
  const seg = 10;
  const before = b.matter;
  b.matter = MATTER.snow;
  const idx: number[][] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const row: number[] = [];
    const lift = Math.cos((t * Math.PI) / 2);
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * TAU;
      const rr = Math.sin((t * Math.PI) / 2) * (i === rings ? 1.04 : 0.92 + rand() * 0.16);
      const lx = Math.cos(a) * rr * (alongX ? len : width);
      const lz = Math.sin(a) * rr * (alongX ? width : len);
      row.push(b.vertex(x + lx, y + h * lift * (i === 0 ? 1 : 0.9 + rand() * 0.2) - (i === rings ? 0.15 : 0), z + lz, SNOW * (0.94 + rand() * 0.06)));
    }
    idx.push(row);
  }
  const top = b.vertex(x, y + h, z, SNOW);
  for (let j = 0; j < seg; j++) b.tri(top, idx[0][(j + 1) % seg], idx[0][j]);
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const k = (j + 1) % seg;
      b.tri(idx[i][j], idx[i][k], idx[i + 1][k]);
      b.tri(idx[i][j], idx[i + 1][k], idx[i + 1][j]);
    }
  }
  b.matter = before;
}

/** The room inside: the inner faces of the walls, and the ceiling's height. */
const IX = W / 2 - LOG_R - 0.02;
const IZ = D / 2 - LOG_R - 0.02;
const CEIL = WALL + 0.2;
/** Logs and boards indoors: the same wood, out of the weather and the light. */
const WOOD_IN = 0.5;
const SEAM = 0.16;

/**
 * The light in the room comes only through the door and the windows at the front: the
 * vertices added since `from` dim towards the back and up under the ceiling.
 */
function dimIndoors(b: GeoBuilder, from: number, lift = 0): void {
  for (let i = from; i < b.positions.length / 3; i++) {
    const y = b.positions[i * 3 + 1] + lift;
    const z = b.positions[i * 3 + 2];
    const depth = THREE.MathUtils.clamp((IZ - z) / (2 * IZ), 0, 1);
    const k = Math.pow((1 - 0.35 * depth) * (1 - 0.2 * THREE.MathUtils.clamp((y - 1.2) / 1.2, 0, 1)), 2.2);
    for (let c = 0; c < 3; c++) b.colors[i * 3 + c] *= k;
  }
}

/**
 * One inner wall: a rounded rib for each course of logs, dark in the seams between them.
 * It runs from `o` along `a` for `len`, bulging towards `n`; `holes` are spans along it
 * (from, to, bottom, top) left open for the door and the window.
 */
function lining(b: GeoBuilder, rand: Rand, o: V, a: V, n: V, len: number, holes: [number, number, number, number][] = []): void {
  const bulge = 0.05;
  const p = (s: number, y: number, out: number) => o.clone().addScaledVector(a, s).addScaledVector(n, out).setY(y);
  for (let y0 = 0; y0 < CEIL - 1e-3; y0 += COURSE) {
    const y1 = Math.min(CEIL, y0 + COURSE);
    const h = y1 - y0;
    const rows: [number, number, number][] = [
      [y0, 0, SEAM],
      [y0 + h * 0.3, bulge, WOOD_IN * (0.85 + rand() * 0.2)],
      [y0 + h * 0.72, bulge * 0.9, WOOD_IN * (0.95 + rand() * 0.2)],
      [y1, 0, SEAM]
    ];
    const cuts = holes.filter(([, , lo, hi]) => y1 > lo && y0 < hi).sort((p, q) => p[0] - q[0]);
    const spans: [number, number][] = [];
    let s = 0;
    for (const [s0, s1] of cuts) {
      if (s0 > s) spans.push([s, s0]);
      s = Math.max(s, s1);
    }
    if (s < len) spans.push([s, len]);
    for (const [s0, s1] of spans) {
      const idx = rows.map(([y, out, g]) => [b.vertex(...p(s0, y, out).toArray(), g * (0.9 + rand() * 0.2)), b.vertex(...p(s1, y, out).toArray(), g * (0.9 + rand() * 0.2))]);
      for (let r = 0; r < rows.length - 1; r++) {
        b.tri(idx[r][0], idx[r][1], idx[r + 1][1]);
        b.tri(idx[r][0], idx[r + 1][1], idx[r + 1][0]);
      }
    }
  }
}

/** A table: four legs under a top of two boards, with a candle stub and a mug on it, and a stool. */
function table(b: GeoBuilder, x0: number, z0: number, x1: number, z1: number): void {
  const top = 0.74;
  const leg = 0.07;
  for (const [x, z] of [[x0 + 0.05, z0 + 0.05], [x1 - 0.05 - leg, z0 + 0.05], [x0 + 0.05, z1 - 0.05 - leg], [x1 - 0.05 - leg, z1 - 0.05 - leg]])
    block(b, x, 0, z, x + leg, top, z + leg, WOOD_IN * 0.85);
  block(b, x0 + 0.08, top - 0.12, z0 + 0.08, x1 - 0.08, top - 0.04, z1 - 0.08, WOOD_IN * 0.8);
  const mz = (z0 + z1) / 2;
  block(b, x0, top, z0, x1, top + 0.05, mz - 0.006, 0.5, 0.56);
  block(b, x0, top, mz + 0.006, x1, top + 0.05, z1, 0.46, 0.52);
  // A candle stub in a dish, pale, and a dark mug.
  const cx = x0 + (x1 - x0) * 0.62;
  const cz = z0 + (z1 - z0) * 0.4;
  block(b, cx - 0.07, top + 0.05, cz - 0.07, cx + 0.07, top + 0.07, cz + 0.07, 0.3);
  block(b, cx - 0.025, top + 0.07, cz - 0.025, cx + 0.025, top + 0.2, cz + 0.025, 0.74, 0.76);
  const mx = x0 + (x1 - x0) * 0.3;
  const mz2 = z0 + (z1 - z0) * 0.62;
  block(b, mx - 0.045, top + 0.05, mz2 - 0.045, mx + 0.045, top + 0.16, mz2 + 0.045, 0.22, 0.12);
  // The stool, pulled out towards the door.
  const sx = (x0 + x1) / 2;
  const sz = z1 + 0.32;
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) block(b, sx + dx * 0.11 - 0.025, 0, sz + dz * 0.11 - 0.025, sx + dx * 0.11 + 0.025, 0.42, sz + dz * 0.11 + 0.025, WOOD_IN * 0.8);
  block(b, sx - 0.17, 0.42, sz - 0.17, sx + 0.17, 0.47, sz + 0.17, 0.42, 0.48);
}

/** A plank bed, its head against the back wall: a straw mattress, a grey wool blanket, a pillow. */
function bed(b: GeoBuilder, x0: number, z0: number, x1: number, z1: number): void {
  const post = 0.08;
  const frame = WOOD_IN * 0.95;
  // Posts: tall at the head, short at the foot.
  for (const [x, z, h] of [[x0, z0, 0.85], [x1 - post, z0, 0.85], [x0, z1 - post, 0.52], [x1 - post, z1 - post, 0.52]] as const)
    block(b, x, 0, z, x + post, h, z + post, frame, 0.42);
  block(b, x0 + post, 0.42, z0 + 0.01, x1 - post, 0.8, z0 + 0.06, frame * 1.05);
  block(b, x0 + post, 0.22, z1 - 0.07, x1 - post, 0.48, z1 - 0.02, frame * 1.05);
  for (const x of [x0 + 0.01, x1 - 0.06]) block(b, x, 0.2, z0 + post, x + 0.05, 0.34, z1 - post, frame);
  b.matter = MATTER.straw;
  block(b, x0 + 0.05, 0.3, z0 + 0.06, x1 - 0.05, 0.44, z1 - 0.07, 0.36, 0.42);
  b.matter = MATTER.rock;
  block(b, x0 + 0.02, 0.3, z0 + 0.5, x1 - 0.02, 0.5, z1 - 0.06, 0.34, 0.4);
  block(b, x0 + 0.03, 0.49, z0 + 0.5, x1 - 0.03, 0.51, z0 + 0.62, 0.46);
  b.matter = MATTER.snow;
  block(b, x0 + 0.12, 0.44, z0 + 0.1, x1 - 0.12, 0.55, z0 + 0.42, 0.6, 0.7);
  b.matter = MATTER.plank;
}

/** A chest, its front facing the door: a box of boards, a lid, iron bands and a lock. */
function chest(b: GeoBuilder, x0: number, z0: number, x1: number, z1: number): void {
  block(b, x0, 0.04, z0, x1, 0.4, z1, WOOD_IN * 1.05);
  block(b, x0 - 0.02, 0.4, z0 - 0.02, x1 + 0.02, 0.49, z1 + 0.02, WOOD_IN * 1.15, 0.5);
  for (const [x, z] of [[x0 + 0.02, z0 + 0.02], [x1 - 0.08, z0 + 0.02], [x0 + 0.02, z1 - 0.08], [x1 - 0.08, z1 - 0.08]]) block(b, x, 0, z, x + 0.06, 0.04, z + 0.06, WOOD_IN * 0.7);
  b.matter = MATTER.rock;
  for (const t of [0.18, 0.82]) {
    const x = x0 + (x1 - x0) * t;
    block(b, x - 0.025, 0.04, z1 + 0.003, x + 0.025, 0.4, z1 + 0.012, 0.16);
    block(b, x - 0.025, 0.4, z0 - 0.025, x + 0.025, 0.5, z1 + 0.025, 0.16, 0.2);
  }
  const mx = (x0 + x1) / 2;
  block(b, mx - 0.045, 0.26, z1 + 0.003, mx + 0.045, 0.38, z1 + 0.016, 0.22);
  block(b, mx - 0.012, 0.29, z1 + 0.016, mx + 0.012, 0.33, z1 + 0.022, 0.04);
  b.matter = MATTER.plank;
}

const RIDGE_Y = WALL + RIDGE;
/** Where the roof line is at a height above the walls: its distance out from the ridge. */
const roofX = (y: number) => (W / 2) * (1 - (y - WALL) / RIDGE);
const EAVE_Y = WALL - (EAVE / (W / 2)) * RIDGE;

/** One plane of the roof, down to the side `side`, with its blanket of snow rounding over the eave and the gables. */
function roofSide(b: GeoBuilder, rand: Rand, side: 1 | -1): void {
  const z0 = -D / 2 - GABLE;
  const z1 = D / 2 + GABLE;
  const eaveX = side * (W / 2 + EAVE);
  // Boards: a thin dark slab, seen from below at the eaves and the gables.
  quad(b, [v(0, RIDGE_Y, z0), v(0, RIDGE_Y, z1), v(eaveX, EAVE_Y, z1), v(eaveX, EAVE_Y, z0)], 0.2);
  const lip = 0.07;
  quad(b, [v(eaveX, EAVE_Y, z0), v(eaveX, EAVE_Y, z1), v(eaveX, EAVE_Y + lip, z1), v(eaveX, EAVE_Y + lip, z0)], 0.24);
  const before = b.matter;
  b.matter = MATTER.snow;
  const nz = 9;
  const ns = 5;
  const grid: number[][] = [];
  for (let i = 0; i <= nz; i++) {
    const row: number[] = [];
    const tz = i / nz;
    const edge = Math.min(tz, 1 - tz) * nz;
    for (let j = 0; j <= ns; j++) {
      const ts = j / ns;
      const thick = (0.26 + rand() * 0.1) * Math.min(1, edge * 0.5 + 0.65) * (j === ns ? 0.5 : 1);
      row.push(b.vertex(eaveX * ts * 1.03, RIDGE_Y + (EAVE_Y - RIDGE_Y) * ts + thick + lip, z0 - 0.04 + (z1 - z0 + 0.08) * tz, SNOW * (0.93 + rand() * 0.07)));
    }
    grid.push(row);
  }
  for (let i = 0; i < nz; i++) {
    for (let j = 0; j < ns; j++) {
      b.tri(grid[i][j], grid[i + 1][j], grid[i + 1][j + 1]);
      b.tri(grid[i][j], grid[i + 1][j + 1], grid[i][j + 1]);
    }
  }
  // The snow's face over the front and back gables, white down to the boards.
  for (const i of [0, nz]) {
    for (let j = 0; j < ns; j++) {
      const a = grid[i][j];
      const c = grid[i][j + 1];
      const lo = (k: number) => {
        const x = b.positions[k * 3];
        const y = RIDGE_Y + (EAVE_Y - RIDGE_Y) * Math.min(1, Math.abs(x) / Math.abs(eaveX)) - 0.02;
        return b.vertex(x, y, b.positions[k * 3 + 2], SNOW * 0.86);
      };
      const la = lo(a);
      const lc = lo(c);
      b.tri(a, c, lc);
      b.tri(a, lc, la);
    }
  }
  // The snow's edge over the eave, hanging down a little.
  for (let i = 0; i < nz; i++) {
    const a = grid[i][ns];
    const c = grid[i + 1][ns];
    const lo = (k: number) => b.vertex(b.positions[k * 3], EAVE_Y - 0.04, b.positions[k * 3 + 2], SNOW * 0.88);
    const la = lo(a);
    const lc = lo(c);
    b.tri(a, c, lc);
    b.tri(a, lc, la);
  }
  b.matter = before;
}

/** Spans of a log along the front from xa to xb, broken where the door and the window are. */
function frontSpans(y: number, xa: number, xb: number): [number, number][] {
  const holes: [number, number][] = [];
  if (y - LOG_R < DOOR_H && y + LOG_R > 0.05) holes.push([DOOR_L - 0.05, DOOR_R + 0.05]);
  if (y + LOG_R > WIN_LO && y - LOG_R < WIN_HI) holes.push([WIN_X - WIN_W / 2 - 0.03, WIN_X + WIN_W / 2 + 0.03]);
  holes.sort((p, q) => p[0] - q[0]);
  const spans: [number, number][] = [];
  let x = xa;
  for (const [h0, h1] of holes) {
    if (h0 > x) spans.push([x, h0]);
    x = Math.max(x, h1);
  }
  if (x < xb) spans.push([x, xb]);
  return spans;
}

/**
 * A small square log cabin of the northern forests, half snowed in: logs notched at
 * the corners with their ends sticking out, a steep gable roof under a thick blanket
 * of snow with carved bargeboards and a chimney, a window with a pale frame and open
 * shutters, and a plank door standing a little open on a dim room: log walls, a board
 * floor and ceiling, a table with a candle stub and a mug, a stool, a chest and a bed.
 * The front (local +Z) is the gable end, with the door and the window.
 */
export class Hut {
  readonly group = new THREE.Group();
  readonly position = new THREE.Vector3();
  /** Rotation about Y: local +Z, the front, faces (sin yaw, cos yaw). */
  yaw = 0;
  private body: THREE.BufferGeometry;
  private doorGeo: THREE.BufferGeometry;
  private floorGeo: THREE.BufferGeometry;
  /** The room's board floor and furniture, fixed flush with the sill. */
  private floor: THREE.Mesh;
  private hinge = new THREE.Group();
  private opening = 0;

  constructor(material: THREE.Material) {
    const rand = mulberry32(0x1a7);
    const b = new GeoBuilder();
    b.matter = MATTER.plank;
    const front = D / 2 + LOG_R;

    // Walls: foundation courses run a metre down into the snow, so a slope never shows a gap underneath;
    // the front and back carry on up as the gables.
    for (let i = -4; LOG_R + i * COURSE < RIDGE_Y - 0.2; i++) {
      const y = LOG_R + i * COURSE;
      const gable = y > WALL;
      const half = gable ? roofX(y) + 0.02 : W / 2 + LAP;
      for (const s of [1, -1]) {
        const z = (s * D) / 2;
        const spans = s > 0 && !gable ? frontSpans(y, -half, half) : [[-half, half]];
        for (const [x0, x1] of spans) log(b, rand, v(x0, y, z), v(x1, y, z), LOG_R, gable ? 0.7 : 0.5);
      }
      const ys = y + COURSE / 2;
      if (ys < WALL) for (const s of [1, -1]) log(b, rand, v((s * W) / 2, ys, -D / 2 - LAP), v((s * W) / 2, ys, D / 2 + LAP), LOG_R, 0.5);
    }
    // A little dark vent high in the front gable.
    quad(b, [v(-0.16, WALL + 0.55, front + 0.01), v(0.16, WALL + 0.55, front + 0.01), v(0.16, WALL + 0.82, front + 0.01), v(-0.16, WALL + 0.82, front + 0.01)], 0.03);

    // Door frame: two posts, a lintel and a sill bridging the wall to the floor.
    block(b, DOOR_L - 0.12, 0, IZ - 0.01, DOOR_L - 0.02, DOOR_H + 0.08, front - 0.02, 0.3);
    block(b, DOOR_R + 0.02, 0, IZ - 0.01, DOOR_R + 0.12, DOOR_H + 0.08, front - 0.02, 0.3);
    block(b, DOOR_L - 0.14, DOOR_H, IZ - 0.01, DOOR_R + 0.14, DOOR_H + 0.16, front - 0.01, 0.32, SNOW);
    block(b, DOOR_L - 0.12, -0.22, IZ - 0.03, DOOR_R + 0.12, 0.024, front - 0.02, 0.3, 0.34);

    // The window: black panes behind a cross of glazing bars, a pale carved frame with a
    // peaked top and a sill under snow, and shutters standing open either side.
    const wl = WIN_X - WIN_W / 2;
    const wr = WIN_X + WIN_W / 2;
    const zf = front + 0.01;
    // Black behind the whole gap in the logs, so the slits round the frame read as shadow.
    quad(b, [v(wl - 0.04, WIN_LO - 0.15, D / 2 - 0.02), v(wr + 0.04, WIN_LO - 0.15, D / 2 - 0.02), v(wr + 0.04, WIN_HI + 0.2, D / 2 - 0.02), v(wl - 0.04, WIN_HI + 0.2, D / 2 - 0.02)], 0.03);
    block(b, WIN_X - 0.02, WIN_LO, D / 2 - 0.02, WIN_X + 0.02, WIN_HI, D / 2 + 0.02, 0.34);
    block(b, wl, WIN_LO + (WIN_HI - WIN_LO) * 0.55 - 0.02, D / 2 - 0.02, wr, WIN_LO + (WIN_HI - WIN_LO) * 0.55 + 0.02, D / 2 + 0.02, 0.34);
    block(b, wl - 0.1, WIN_LO - 0.04, zf, wl, WIN_HI + 0.04, zf + 0.05, TRIM);
    block(b, wr, WIN_LO - 0.04, zf, wr + 0.1, WIN_HI + 0.04, zf + 0.05, TRIM);
    block(b, wl - 0.16, WIN_LO - 0.12, zf, wr + 0.16, WIN_LO - 0.04, zf + 0.12, TRIM, SNOW);
    block(b, wl - 0.14, WIN_HI + 0.04, zf, wr + 0.14, WIN_HI + 0.12, zf + 0.07, TRIM, SNOW);
    {
      const t0 = b.vertex(wl - 0.14, WIN_HI + 0.12, zf + 0.06, TRIM);
      const t1 = b.vertex(wr + 0.14, WIN_HI + 0.12, zf + 0.06, TRIM);
      const t2 = b.vertex(WIN_X, WIN_HI + 0.34, zf + 0.06, TRIM * 1.05);
      b.tri(t0, t1, t2);
      // A carved notch in the middle of the peak, dark.
      const n0 = b.vertex(WIN_X - 0.05, WIN_HI + 0.15, zf + 0.065, 0.12);
      const n1 = b.vertex(WIN_X + 0.05, WIN_HI + 0.15, zf + 0.065, 0.12);
      const n2 = b.vertex(WIN_X, WIN_HI + 0.25, zf + 0.065, 0.12);
      b.tri(n0, n1, n2);
    }
    for (const s of [-1, 1]) {
      const x0 = s < 0 ? wl - 0.1 - 0.3 : wr + 0.1;
      for (let k = 0; k < 2; k++) {
        const g = TRIM * (0.82 + k * 0.08);
        block(b, x0 + k * 0.15 + 0.005, WIN_LO - 0.02, zf + 0.005, x0 + (k + 1) * 0.15 - 0.005, WIN_HI + 0.02, zf + 0.04, g, SNOW);
      }
      block(b, x0 + 0.02, WIN_LO + 0.08, zf + 0.04, x0 + 0.28, WIN_LO + 0.13, zf + 0.06, TRIM * 0.7);
      block(b, x0 + 0.02, WIN_HI - 0.13, zf + 0.04, x0 + 0.28, WIN_HI - 0.08, zf + 0.06, TRIM * 0.7);
    }

    // A small window in the right-hand wall too, black behind its sticks.
    const wx = W / 2 + LOG_R + 0.01;
    quad(b, [v(wx, 1.0, 0.25), v(wx, 1.0, -0.25), v(wx, 1.42, -0.25), v(wx, 1.42, 0.25)], 0.02);
    block(b, wx, 0.94, -0.33, wx + 0.1, 1.0, 0.33, TRIM, SNOW);
    block(b, wx, 1.42, -0.33, wx + 0.06, 1.48, 0.33, TRIM, SNOW);
    block(b, wx, 1.0, -0.31, wx + 0.05, 1.42, -0.25, TRIM);
    block(b, wx, 1.0, 0.25, wx + 0.05, 1.42, 0.31, TRIM);
    block(b, wx, 1.0, -0.015, wx + 0.04, 1.42, 0.015, 0.3);

    // The room: log walls and a board ceiling, dim, lit only from the front.
    const room = b.positions.length / 3;
    lining(b, rand, v(-IX, 0, -IZ), v(1, 0, 0), v(0, 0, 1), 2 * IX);
    lining(b, rand, v(-IX, 0, IZ), v(0, 0, -1), v(1, 0, 0), 2 * IZ);
    lining(b, rand, v(IX, 0, -IZ), v(0, 0, 1), v(-1, 0, 0), 2 * IZ);
    lining(b, rand, v(-IX, 0, IZ), v(1, 0, 0), v(0, 0, -1), 2 * IX, [
      [DOOR_L + IX, DOOR_R + IX, -1, DOOR_H],
      [WIN_X - WIN_W / 2 + IX, WIN_X + WIN_W / 2 + IX, WIN_LO, WIN_HI]
    ]);
    const boards = 11;
    for (let i = 0; i < boards; i++) {
      const x0 = -IX + (2 * IX * i) / boards;
      const x1 = -IX + (2 * IX * (i + 1)) / boards;
      quad(b, [v(x0, CEIL, -IZ), v(x0, CEIL, IZ), v(x1, CEIL, IZ), v(x1, CEIL, -IZ)], WOOD_IN * (0.75 + rand() * 0.25));
    }
    for (const z of [-0.8, 0.6]) block(b, -IX, CEIL - 0.16, z - 0.08, IX, CEIL, z + 0.08, WOOD_IN * 0.8);
    dimIndoors(b, room);

    roofSide(b, rand, 1);
    roofSide(b, rand, -1);
    // Snow along the ridge.
    b.matter = MATTER.snow;
    log(b, rand, v(0, RIDGE_Y + 0.24, -D / 2 - GABLE), v(0, RIDGE_Y + 0.24, D / 2 + GABLE), 0.17, 1);
    b.matter = MATTER.plank;
    // Bargeboards along the front gable's edges, meeting under a little post at the peak.
    const zb = D / 2 + GABLE - 0.02;
    for (const s of [1, -1]) {
      const a = v(0, RIDGE_Y + 0.02, zb);
      const c = v(s * (W / 2 + EAVE + 0.04), EAVE_Y - 0.02, zb);
      const along = c.clone().sub(a).normalize();
      const down = v(-along.y * s, along.x * s, 0).normalize();
      if (down.y > 0) down.negate();
      board(b, a, c, down, 0.2, 0.05, 0.5);
    }
    block(b, -0.05, RIDGE_Y - 0.25, zb, 0.05, RIDGE_Y + 0.3, zb + 0.06, 0.5, SNOW);
    // A chimney of stacked stones through the right-hand slope, capped with snow.
    b.matter = MATTER.rock;
    block(b, 0.3, WALL + 0.5, -0.95, 0.68, RIDGE_Y + 0.55, -0.57, 0.3);
    block(b, 0.26, RIDGE_Y + 0.55, -0.99, 0.72, RIDGE_Y + 0.63, -0.53, 0.34, SNOW);
    block(b, 0.33, RIDGE_Y + 0.63, -0.92, 0.65, RIDGE_Y + 0.72, -0.6, SNOW);

    // Drifts: deep against the back and the left-hand wall, the doorway dug clear. Each lies
    // wholly outside the walls (its inner edge under the logs), so none shows inside.
    heap(b, rand, 0, -D / 2 - 0.85, -0.1, W / 2 + 0.6, 0.78, 1.05, true);
    heap(b, rand, -W / 2 - 0.85, 0, -0.1, D / 2 + 0.4, 0.78, 1.15, false);
    heap(b, rand, W / 2 + 0.72, -0.4, -0.1, D / 2 - 0.2, 0.62, 0.55, false);
    heap(b, rand, WIN_X + 0.1, D / 2 + 0.6, -0.1, 0.75, 0.52, 0.7, true);
    heap(b, rand, -W / 2 - 0.05, D / 2 + 0.55, -0.1, 0.35, 0.48, 0.5, true);
    this.body = b.build();

    // The door: four planks on two battens, hung on its left-hand side.
    const d = new GeoBuilder();
    d.matter = MATTER.plank;
    const plank = DOOR_W / 4;
    for (let p = 0; p < 4; p++) {
      // Paler than the logs, bleached by the weather, so the dark gap beside it shows.
      const g = 0.5 + (p % 2) * 0.05 + rand() * 0.05;
      block(d, p * plank + 0.006, 0.03, -0.03, (p + 1) * plank - 0.006, DOOR_H - 0.02 - rand() * 0.03, 0.03, g, SNOW);
    }
    block(d, 0.04, 0.3, -0.07, DOOR_W - 0.04, 0.42, -0.03, 0.34);
    block(d, 0.04, DOOR_H - 0.45, -0.07, DOOR_W - 0.04, DOOR_H - 0.33, -0.03, 0.34);
    block(d, DOOR_W - 0.16, 0.95, 0.03, DOOR_W - 0.1, 1.15, 0.08, 0.3);
    this.doorGeo = d.build();
    this.hinge.position.set(DOOR_L, 0, D / 2);
    this.hinge.add(new THREE.Mesh(this.doorGeo, material));

    // The floor, and all that stands on it: level boards running in from the door, a table against
    // the back wall straight ahead of the door's gap, a chest in the corner beside it, and a bed
    // along the right-hand wall under the window.
    const f = new GeoBuilder();
    f.matter = MATTER.plank;
    // Dark under the cracks between the boards, running into the walls so nothing outside can show through.
    quad(f, [v(-W / 2, -0.04, -D / 2), v(W / 2, -0.04, -D / 2), v(W / 2, -0.04, D / 2), v(-W / 2, -0.04, D / 2)], SEAM);
    const planks = 13;
    for (let i = 0; i < planks; i++) {
      const x0 = -IX + (2 * IX * i) / planks + 0.008;
      const x1 = -IX + (2 * IX * (i + 1)) / planks - 0.008;
      const cut = -IZ + 2 * IZ * (0.3 + rand() * 0.4);
      for (const [z0, z1] of [[-IZ, cut - 0.006], [cut + 0.006, IZ]]) quad(f, [v(x0, 0.004, z0), v(x0, 0.004, z1), v(x1, 0.004, z1), v(x1, 0.004, z0)], WOOD_IN * (0.85 + rand() * 0.3));
    }
    table(f, -0.85, -IZ + 0.03, -0.05, -IZ + 0.63);
    chest(f, -IX + 0.08, -IZ + 0.05, -IX + 0.7, -IZ + 0.47);
    bed(f, IX - 0.74, -IZ, IX - 0.01, -IZ + 1.9);
    dimIndoors(f, 0);
    this.floorGeo = f.build();
    this.floor = new THREE.Mesh(this.floorGeo, material);
    this.floor.position.y = 0.02;
    this.group.add(new THREE.Mesh(this.body, material), this.hinge, this.floor);
    this.group.visible = false;
    this.setDoor(0);
  }

  /** Puts the hut down with its floor at y, the front facing (fx, fz). */
  place(x: number, y: number, z: number, fx: number, fz: number): void {
    this.position.set(x, y, z);
    this.yaw = Math.atan2(fx, fz);
    this.group.position.set(x, y, z);
    this.group.rotation.set(0, this.yaw, 0);
    this.group.visible = true;
    this.setDoor(0);
  }

  hide(): void {
    this.group.visible = false;
  }

  /** 0: standing ajar as found; 1: pushed half open. */
  setDoor(t: number): void {
    this.opening = t;
    this.hinge.rotation.y = AJAR + (OPEN - AJAR) * t;
  }

  get door(): number {
    return this.opening;
  }

  /** A point in the hut's own frame (X along the front, Z out of it), in the world. */
  toWorld(lx: number, ly: number, lz: number, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    return out.set(this.position.x + lx * c + lz * s, this.position.y + ly, this.position.z - lx * s + lz * c);
  }

  /** Where someone stands to go in: just out from the doorway. */
  doorstep(out: THREE.Vector3, ahead = 0.5): THREE.Vector3 {
    return this.toWorld(DOOR_X, 0, D / 2 + ahead, out);
  }

  /**
   * On the line through the gap the half-open door leaves (between its free edge and
   * the right-hand post), `ahead` out from the wall (negative: inside), at eye height.
   */
  gap(out: THREE.Vector3, ahead: number): THREE.Vector3 {
    return this.toWorld(DOOR_R - 0.22, 1.6, D / 2 + ahead, out);
  }

  /** How far a point lies out in front of the wall with the door (negative: behind it). */
  frontOf(x: number, z: number): number {
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    return dx * Math.sin(this.yaw) + dz * Math.cos(this.yaw) - D / 2;
  }

  /** Walls all round: the doorway is reached before the wall would stop anyone. */
  colliders(): Collider[] {
    const out: Collider[] = [];
    const p = new THREE.Vector3();
    const hx = W / 2 + 0.1;
    const hz = D / 2 + 0.1;
    const add = (lx: number, lz: number) => {
      this.toWorld(lx, 0, lz, p);
      out.push({ x: p.x, z: p.z, r: 0.55, walk: 0.4 });
    };
    for (let x = -hx; x <= hx + 1e-6; x += 0.5) {
      add(x, hz);
      add(x, -hz);
    }
    for (let z = -hz + 0.5; z < hz - 1e-6; z += 0.5) {
      add(hx, z);
      add(-hx, z);
    }
    return out;
  }

  /** Radius of ground it needs kept clear of trees. */
  static readonly CLEARING = 8;
  /** Radius levelled flat under the hut and its drifts (wider than the walls by a grid square, so no tilted triangle reaches inside). */
  static readonly PAD = 4.2;
  /** How far the hut sits above the levelled snow outside, keeping the boards clear of it. */
  static readonly STEP = 0.1;
  /** For setDoor(): pulled shut behind whoever went in. */
  static readonly SHUT = -AJAR / (OPEN - AJAR);
  /** Door horizontal offset and front wall distance from the cabin's centre (local frame). */
  static readonly DOOR_X = DOOR_X;
  static readonly FRONT = D / 2;
  /** Corners of the footprint (with the drifts), in its own frame, for judging the ground; the last is the doorstep. */
  static readonly FOOTPRINT: [number, number][] = [
    [-W / 2 - 0.8, -D / 2 - 0.8],
    [W / 2 + 0.8, -D / 2 - 0.8],
    [W / 2 + 0.8, D / 2 + 0.8],
    [-W / 2 - 0.8, D / 2 + 0.8],
    [0, 0],
    [DOOR_X, D / 2 + 1.5]
  ];

  dispose(): void {
    this.body.dispose();
    this.doorGeo.dispose();
    this.floorGeo.dispose();
  }
}
