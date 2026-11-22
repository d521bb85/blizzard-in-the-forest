import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { mulberry32 } from "../lib/noise";

/**
 * What a vertex is made of. The grays say how light it is; in colour, this says
 * which hue the gray takes. Wood is what anything is unless told otherwise.
 */
export const MATTER = {
  /** Bark, logs, twigs: brown, with snow on it where the gray is pale. */
  wood: 0,
  /** Needles: green, with snow on them where the gray is pale. */
  needle: 1,
  /** Snow, whatever its gray. */
  snow: 2,
  /** Stone, with snow on it where the gray is pale. */
  rock: 3,
  /** Dry grass. */
  straw: 4,
  /** Weathered logs and planed boards: wood that stays wood even when pale; only the palest is snow. */
  plank: 5,
  /** Birch bark: dark marks, and cream where it is pale. */
  birch: 6
} as const;

/** Accumulates indexed triangles with per-vertex grayscale colour. */
export class GeoBuilder {
  positions: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  /** What the vertices added from now on are made of: one of MATTER. */
  matter: number = MATTER.wood;
  private matters: number[] = [];

  vertex(x: number, y: number, z: number, gray: number): number {
    const lin = Math.pow(Math.min(1, Math.max(0, gray)), 2.2);
    this.positions.push(x, y, z);
    this.colors.push(lin, lin, lin);
    this.matters.push(this.matter);
    return this.positions.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(this.colors, 3));
    // Left out when it is all wood: a shader reads a missing attribute as 0.
    if (this.matters.some((m) => m !== MATTER.wood)) geo.setAttribute("matter", new THREE.Float32BufferAttribute(this.matters, 1));
    geo.setIndex(this.indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

export const TAU = Math.PI * 2;
export const BARK = 0.13;
const NEEDLE = 0.1;
export const SNOW = 0.93;

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Tapered tube between two points; top-facing vertices collect snow. */
export function tube(
  b: GeoBuilder,
  rand: () => number,
  start: THREE.Vector3,
  end: THREE.Vector3,
  r0: number,
  r1: number,
  sides: number,
  snowiness: number
): void {
  const dir = new THREE.Vector3().subVectors(end, start).normalize();
  const helper = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(dir, helper).normalize();
  const v = new THREE.Vector3().crossVectors(dir, u).normalize();
  const ring0: number[] = [];
  const ring1: number[] = [];
  const radial = new THREE.Vector3();
  const offset = rand() * TAU;
  for (let i = 0; i < sides; i++) {
    const a = offset + (i / sides) * TAU;
    radial.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a));
    const up = radial.y;
    const snowy = up > 0.35 - snowiness * 0.3 && rand() < 0.4 + snowiness * 0.6;
    const c = snowy ? mix(0.55, SNOW, rand()) : BARK * (0.7 + rand() * 0.6);
    ring0.push(b.vertex(start.x + radial.x * r0, start.y + radial.y * r0, start.z + radial.z * r0, c));
    ring1.push(b.vertex(end.x + radial.x * r1, end.y + radial.y * r1, end.z + radial.z * r1, c));
  }
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    b.tri(ring0[i], ring1[i], ring1[j]);
    b.tri(ring0[i], ring1[j], ring0[j]);
  }
}

/**
 * A spruce tier gets in the walker's way only if its branch tips hang below this
 * height (unscaled), and then only its inner, denser part: the walker brushes
 * through the outer tips, so a gap that looks passable is.
 */
// About the highest an eye can reach in a tree's own units: (eye 1.68 m + 0.55 m sunk) / smallest scale 0.75.
const WALK_TIER_LOW = 3.1;
const WALK_TIER_REACH = 0.72;

export type TreeKind = "spruce" | "young" | "pine" | "birch" | "bare" | "snag" | "mound" | "bush" | "grass" | "stump" | "rock";

export interface TreeVariant {
  geometry: THREE.BufferGeometry;
  /** Collision radius at eye height, in unscaled units (deer keep clear of it). */
  radius: number;
  /** What the walker bumps into, in unscaled units: smaller, as it can push through branch tips. */
  walkRadius: number;
  /** Mounds only: the drift's shape, for walking over it. Unscaled, above its base. */
  climb?: { top: number; reach: number };
  kind: TreeKind;
}

/**
 * A tube through a row of points, its rings shared between the segments, so it
 * bends without a break. `gray` colours each vertex, given its ring and the way
 * it faces.
 */
export function limb(
  b: GeoBuilder,
  rand: () => number,
  pts: THREE.Vector3[],
  radii: number[],
  sides: number,
  gray: (ring: number, radial: THREE.Vector3) => number
): void {
  const dir = new THREE.Vector3();
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  const radial = new THREE.Vector3();
  const helper = new THREE.Vector3();
  const offset = rand() * TAU;
  let prev: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    dir.subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]).normalize();
    helper.set(Math.abs(dir.y) > 0.9 ? 1 : 0, Math.abs(dir.y) > 0.9 ? 0 : 1, 0);
    u.crossVectors(dir, helper).normalize();
    v.crossVectors(dir, u).normalize();
    const ring: number[] = [];
    for (let k = 0; k < sides; k++) {
      const a = offset + (k / sides) * TAU;
      radial.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a));
      const r = radii[i];
      ring.push(b.vertex(pts[i].x + radial.x * r, pts[i].y + radial.y * r, pts[i].z + radial.z * r, gray(i, radial)));
    }
    if (i > 0) {
      for (let k = 0; k < sides; k++) {
        const j = (k + 1) % sides;
        b.tri(prev[k], ring[k], ring[j]);
        b.tri(prev[k], ring[j], prev[j]);
      }
    }
    prev = ring;
  }
}

/** The side of a tree the blizzard has plastered with snow. */
function windSide(rand: () => number): THREE.Vector3 {
  const a = rand() * TAU;
  return new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
}

/** Bark, with snow packed onto the windward side in patches. */
function barkGray(rand: () => number, radial: THREE.Vector3, side: THREE.Vector3, plaster: number, bark = BARK): number {
  if (radial.dot(side) > 0.4 && rand() < plaster) return mix(0.55, SNOW, rand());
  return bark * (0.7 + rand() * 0.6);
}

/** Stubs of dead branches along a trunk, a little drooped. */
function stubs(
  b: GeoBuilder,
  rand: () => number,
  axis: (y: number) => THREE.Vector3,
  count: number,
  lo: number,
  hi: number,
  r: number
): void {
  for (let i = 0; i < count; i++) {
    const start = axis(mix(lo, hi, rand()));
    const az = rand() * TAU;
    const len = 0.3 + rand() * 0.8;
    const end = start.clone().add(new THREE.Vector3(Math.cos(az) * len, -(0.05 + rand() * 0.2) * len, Math.sin(az) * len));
    tube(b, rand, start, end, r, 0.008, 4, 0.5);
  }
}

export interface SpruceShape {
  /** A sapling: branches to the ground, buried in snow. */
  young?: boolean;
  /** A narrow spire, its short branches bent right down under the snow. */
  slim?: boolean;
  /** An old tree: a high, thin crown with gaps in it, and dead branches below. */
  ragged?: boolean;
}

/** A snow-laden spruce built from drooping, jagged branch tiers. */
export function buildSpruce(seed: number, height: number, { young = false, slim = false, ragged = false }: SpruceShape = {}): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  const H = height;
  const trunkR = 0.06 + H * 0.011;
  // The trunk leans off the vertical towards the top, and the crown follows it.
  const bendA = rand() * TAU;
  const bend = young ? 0 : H * (0.006 + rand() * (ragged ? 0.035 : 0.02));
  const axis = (y: number) => {
    const k = bend * (Math.max(0, y) / H) ** 2;
    return new THREE.Vector3(Math.cos(bendA) * k, y, Math.sin(bendA) * k);
  };
  const side = windSide(rand);
  const ys = [-0.6, H * 0.2, H * 0.45, H * 0.7, H * 0.9];
  limb(
    b,
    rand,
    ys.map(axis),
    ys.map((_, i) => trunkR * mix(1, 0.2, i / (ys.length - 1))),
    6,
    (_, radial) => barkGray(rand, radial, side, 0.45)
  );

  const crownBase = young
    ? H * 0.04
    : ragged
      ? H * (0.26 + rand() * 0.12)
      : slim
        ? Math.max(1.1, H * (0.07 + rand() * 0.06))
        : Math.max(1.4, H * (0.1 + rand() * 0.12));
  const rMax = H * (young ? 0.32 + rand() * 0.08 : slim ? 0.105 + rand() * 0.03 : ragged ? 0.2 + rand() * 0.05 : 0.19 + rand() * 0.06);
  const tiers = Math.max(5, Math.round(H * (young ? 2.6 : slim ? 1.9 : ragged ? 1.05 : 1.6) + rand() * 3));
  const snowiness = young || slim ? 0.85 + rand() * 0.15 : ragged ? 0.3 + rand() * 0.3 : 0.55 + rand() * 0.4;
  // Branches grow longer on the lee side.
  const flag = young ? 0 : ragged ? 0.15 + rand() * 0.25 : rand() * 0.2;
  const flagA = rand() * TAU;
  let radiusAtEye = trunkR;
  let walkRadius = trunkR + 0.12;

  b.matter = MATTER.needle;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = crownBase + (H * 0.95 - crownBase) * Math.pow(t, 0.92);
    const R = rMax * Math.pow(1 - t, 0.82) * (ragged ? 0.6 + rand() * 0.7 : 0.82 + rand() * 0.36) + 0.12;
    const K = Math.max(6, Math.round(6 + R * 2.6));
    const droop = R * (slim ? 0.85 + rand() * 0.5 : 0.42 + rand() * 0.25);
    const lift = R * 0.16;
    const rot = rand() * TAU;
    const tierSnow = snowiness * (0.75 + rand() * 0.25) * (1 - t * 0.35);
    // Each tier hangs a little askew.
    const tilt = young ? 0.05 : 0.14;
    const tx = (rand() - 0.5) * tilt;
    const tz = (rand() - 0.5) * tilt;
    // An old crown has lost whole tiers.
    if (ragged && i > 0 && i < tiers - 2 && rand() < 0.16) continue;
    // Any tier whose skirt reaches head height blocks the way (covers scale and sinking).
    if (y - droop * 1.2 < 4.6) radiusAtEye = Math.max(radiusAtEye, R * 1.05);
    if (y - droop * 1.2 < WALK_TIER_LOW) walkRadius = Math.max(walkRadius, R * WALK_TIER_REACH);
    const c = axis(y);
    const at = (x: number, yy: number, z: number, gray: number) => b.vertex(c.x + x, yy + x * tx + z * tz, c.z + z, gray);

    const top = at(0, y + lift, 0, mix(NEEDLE, SNOW, tierSnow));
    const inner: number[] = [];
    const rimTop: number[] = [];
    const rimBottom: number[] = [];
    const M = K * 2;
    for (let j = 0; j < M; j++) {
      const tip = j % 2 === 0;
      const a = rot + (j / M) * TAU + (rand() - 0.5) * (TAU / M) * 0.6;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const reach = 1 + flag * Math.cos(a - flagA);
      const ri = R * (0.42 + rand() * 0.12);
      const yi = y + lift * 0.3 - droop * 0.12;
      const innerSnow = rand() < tierSnow ? mix(0.7, SNOW, rand()) : mix(NEEDLE, 0.45, rand());
      inner.push(at(ca * ri, yi, sa * ri, innerSnow));

      const ro = (tip ? R * (0.85 + rand() * 0.3) : R * (0.5 + rand() * 0.15)) * reach;
      const yo = tip ? y - droop * (0.8 + rand() * 0.4) : y - droop * 0.45;
      const rimSnow = tip
        ? rand() < tierSnow * 0.5 ? mix(0.5, 0.85, rand()) : NEEDLE * (0.7 + rand() * 0.6)
        : rand() < tierSnow ? mix(0.6, SNOW, rand()) : mix(NEEDLE, 0.3, rand());
      rimTop.push(at(ca * ro, yo, sa * ro, rimSnow));
      rimBottom.push(at(ca * ro, yo - 0.02, sa * ro, NEEDLE * (0.5 + rand() * 0.6)));
    }
    const bottom = at(0, y - droop * 0.35, 0, NEEDLE * 0.5);
    for (let j = 0; j < M; j++) {
      const k = (j + 1) % M;
      b.tri(top, inner[k], inner[j]);
      b.tri(inner[j], rimTop[k], rimTop[j]);
      b.tri(inner[j], inner[k], rimTop[k]);
      b.tri(bottom, rimBottom[j], rimBottom[k]);
    }
  }

  // Dead branches under the crown.
  if (!young) {
    const count = ragged ? 7 + Math.floor(rand() * 6) : 2 + Math.floor(rand() * 4);
    b.matter = MATTER.wood;
    stubs(b, rand, axis, count, 0.8, Math.max(1.4, crownBase + (ragged ? H * 0.2 : 0.5)), trunkR * 0.22);
    b.matter = MATTER.needle;
  }

  // Leader at the top of the crown.
  const tip = axis(H * 1.03);
  tip.x += (rand() - 0.5) * 0.1;
  tube(b, rand, axis(H * 0.9), tip, 0.07, 0.01, 4, 0.6);

  const radius = Math.max(trunkR + 0.15, radiusAtEye);
  return { geometry: b.build(), radius, walkRadius: Math.min(radius, walkRadius), kind: young ? "young" : "spruce" };
}

/** A flat clump of needles at the end of a pine bough: snow on top, dark underneath. */
function pad(b: GeoBuilder, rand: () => number, x: number, y: number, z: number, R: number, snowiness: number): void {
  const M = 14;
  const h = R * (0.5 + rand() * 0.2);
  const rot = rand() * TAU;
  const before = b.matter;
  b.matter = MATTER.needle;
  const top = b.vertex(x, y + h, z, mix(NEEDLE, SNOW, snowiness));
  const inner: number[] = [];
  const rimTop: number[] = [];
  const rimBottom: number[] = [];
  for (let j = 0; j < M; j++) {
    const tip = j % 2 === 0;
    const a = rot + (j / M) * TAU + (rand() - 0.5) * (TAU / M) * 0.6;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const ri = R * (0.55 + rand() * 0.14);
    inner.push(b.vertex(x + ca * ri, y + h * (0.62 + rand() * 0.18), z + sa * ri, rand() < snowiness ? mix(0.7, SNOW, rand()) : mix(NEEDLE, 0.4, rand())));
    const ro = tip ? R * (0.9 + rand() * 0.2) : R * (0.76 + rand() * 0.12);
    const yo = tip ? y - R * (0.02 + rand() * 0.1) : y + h * 0.15;
    const gray = tip
      ? rand() < snowiness * 0.35 ? mix(0.45, 0.8, rand()) : NEEDLE * (0.7 + rand() * 0.6)
      : rand() < snowiness * 0.8 ? mix(0.55, SNOW, rand()) : mix(NEEDLE, 0.3, rand());
    rimTop.push(b.vertex(x + ca * ro, yo, z + sa * ro, gray));
    rimBottom.push(b.vertex(x + ca * ro, yo - 0.02, z + sa * ro, NEEDLE * (0.5 + rand() * 0.6)));
  }
  // The underside bellies down, so the clump has some body seen from below.
  const bottom = b.vertex(x, y - R * 0.14, z, NEEDLE * 0.5);
  for (let j = 0; j < M; j++) {
    const k = (j + 1) % M;
    b.tri(top, inner[k], inner[j]);
    b.tri(inner[j], rimTop[k], rimTop[j]);
    b.tri(inner[j], inner[k], rimTop[k]);
    b.tri(bottom, rimBottom[j], rimBottom[k]);
  }
  b.matter = before;
}

/** A pine: a tall bare trunk, a few dead stubs, and a crown of boughs each carrying a flat, snowed-over clump. */
export function buildPine(seed: number, height: number): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  const H = height;
  const r0 = 0.1 + H * 0.012;
  const side = windSide(rand);
  const bendA = rand() * TAU;
  const bend = H * (0.01 + rand() * 0.035);
  const wobble = rand() * TAU;
  const axis = (y: number) => {
    const t = Math.max(0, y) / H;
    const k = bend * t * t + Math.sin(t * 5 + wobble) * 0.012 * H * t;
    return new THREE.Vector3(Math.cos(bendA) * k, y, Math.sin(bendA) * k);
  };
  const top = H * 0.93;
  const ys = [-0.6, H * 0.12, H * 0.28, H * 0.45, H * 0.6, H * 0.75, H * 0.86, top];
  const radiusAt = (y: number) => r0 * mix(1, 0.2, Math.pow(Math.max(0, y) / top, 1.3));
  limb(b, rand, ys.map(axis), ys.map(radiusAt), 6, (i, radial) =>
    // The bark is paler towards the crown.
    barkGray(rand, radial, side, 0.5, ys[i] > H * 0.5 ? 0.24 : BARK)
  );
  stubs(b, rand, axis, 3 + Math.floor(rand() * 4), H * 0.22, H * 0.58, r0 * 0.2);

  const snowiness = 0.6 + rand() * 0.35;
  const boughs = 8 + Math.floor(rand() * 4);
  const turn = rand() * TAU;
  for (let i = 0; i < boughs; i++) {
    const t = i / (boughs - 1);
    const y0 = H * mix(0.6, 0.9, t) + (rand() - 0.5) * H * 0.03;
    const az = turn + i * 2.4 + (rand() - 0.5) * 0.8;
    const len = H * mix(0.24, 0.1, t) * (0.75 + rand() * 0.5);
    const rise = len * (0.3 + rand() * 0.4);
    const out = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const start = axis(y0);
    // An elbow: out first, then up.
    const mid = start.clone().addScaledVector(out, len * 0.55);
    mid.y += rise * 0.25;
    const end = start.clone().addScaledVector(out, len);
    end.y += rise;
    const r = radiusAt(y0) * 0.5;
    tube(b, rand, start, mid, r, r * 0.6, 5, 0.5);
    tube(b, rand, mid, end, r * 0.6, 0.03, 4, 0.5);
    const R = H * (0.085 + rand() * 0.05) * (1 - t * 0.25);
    pad(b, rand, end.x, end.y, end.z, R, snowiness);
    if (len > H * 0.13) pad(b, rand, mid.x, mid.y + 0.1, mid.z, R * 0.75, snowiness);
  }
  const apex = axis(top);
  pad(b, rand, apex.x, apex.y, apex.z, H * (0.09 + rand() * 0.03), snowiness);

  return { geometry: b.build(), radius: r0 + 0.15, walkRadius: r0 + 0.15, kind: "pine" };
}

/** A birch: a pale trunk ringed with dark marks, steep branches, and fine twigs hanging from them. */
export function buildBirch(seed: number, height: number): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  const H = height;
  const r0 = 0.07 + H * 0.011;
  const bendA = rand() * TAU;
  const bend = H * (0.02 + rand() * 0.06);
  const axis = (y: number) => {
    const t = Math.max(0, y) / H;
    const k = bend * t * (0.4 + 0.6 * t);
    return new THREE.Vector3(Math.cos(bendA) * k, y, Math.sin(bendA) * k);
  };
  const radiusAt = (y: number) => r0 * mix(1, 0.1, Math.pow(Math.max(0, y) / H, 1.1));

  // Rings up the trunk; a mark is two dark rings close together between pale ones.
  const ys: number[] = [-0.5];
  const dark: boolean[] = [false];
  for (let y = 0.25 + rand() * 0.3; y < H * 0.97; y += 0.5 + rand() * 0.6) {
    ys.push(y);
    dark.push(false);
    if (y < H * 0.75 && rand() < 0.55) {
      const w = 0.05 + rand() * 0.1;
      ys.push(y + 0.03, y + 0.03 + w, y + 0.06 + w);
      dark.push(true, true, false);
    }
  }
  ys.push(H * 0.97);
  dark.push(false);
  b.matter = MATTER.birch;
  limb(b, rand, ys.map(axis), ys.map(radiusAt), 6, (i) => {
    // Rough and dark at the foot, dark again where it thins into twigs.
    if (ys[i] < 0.7) return mix(0.14, 0.4, rand());
    if (ys[i] > H * 0.8) return mix(0.1, 0.3, rand());
    return dark[i] && rand() < 0.75 ? 0.07 + rand() * 0.08 : mix(0.72, 0.9, rand());
  });
  b.matter = MATTER.wood;

  const branches = 14 + Math.floor(rand() * 6);
  const turn = rand() * TAU;
  for (let i = 0; i < branches; i++) {
    const t = i / (branches - 1);
    const y0 = H * mix(0.36, 0.9, t);
    const az = turn + i * 2.4 + (rand() - 0.5) * 0.8;
    const len = H * mix(0.3, 0.1, t) * (0.8 + rand() * 0.4);
    // Up at a steep angle, opening outwards along the way.
    const open = 0.45 + rand() * 0.35;
    const out = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const p0 = axis(y0);
    const p1 = p0.clone().addScaledVector(out, Math.sin(open) * len * 0.5);
    p1.y += Math.cos(open) * len * 0.5;
    const p2 = p1.clone().addScaledVector(out, Math.sin(open + 0.35) * len * 0.5);
    p2.y += Math.cos(open + 0.35) * len * 0.5;
    const r = Math.max(0.02, radiusAt(y0) * 0.45);
    tube(b, rand, p0, p1, r, r * 0.6, 4, 0.5);
    tube(b, rand, p1, p2, r * 0.6, 0.012, 4, 0.5);
    // Twigs: a little way out, then hanging.
    const twigs = 3 + Math.floor(rand() * 2);
    for (let k = 0; k < twigs; k++) {
      const from = p1.clone().lerp(p2, k === 0 ? 1 : 0.2 + rand() * 0.7);
      const ta = az + (rand() - 0.5) * 1.6;
      const tl = len * (0.3 + rand() * 0.3);
      const knee = from.clone().add(new THREE.Vector3(Math.cos(ta) * tl * 0.45, tl * 0.05, Math.sin(ta) * tl * 0.45));
      const end = knee.clone().add(new THREE.Vector3(Math.cos(ta) * tl * 0.2, -tl * 0.75, Math.sin(ta) * tl * 0.2));
      tube(b, rand, from, knee, 0.016, 0.011, 3, 0.4);
      tube(b, rand, knee, end, 0.011, 0.005, 3, 0.1);
    }
  }
  return { geometry: b.build(), radius: r0 + 0.15, walkRadius: r0 + 0.15, kind: "birch" };
}

/** Leafless deciduous tree from recursive tapered branches. */
export function buildBareTree(seed: number, height: number): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  const trunkR = height * 0.03;

  const grow = (start: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number): void => {
    const segs = depth === 0 ? 3 : 2;
    let p = start.clone();
    const d = dir.clone();
    let rad = r;
    for (let s = 0; s < segs; s++) {
      d.x += (rand() - 0.5) * 0.25;
      d.z += (rand() - 0.5) * 0.25;
      d.y += 0.06;
      d.normalize();
      const next = p.clone().addScaledVector(d, len / segs);
      const nr = rad * 0.82;
      tube(b, rand, p, next, rad, nr, depth < 2 ? 6 : 4, 0.6);
      p = next;
      rad = nr;
    }
    if (depth >= 4 || rad < 0.012) return;
    const children = depth === 0 ? 4 + Math.floor(rand() * 2) : 2 + Math.floor(rand() * 2);
    for (let c = 0; c < children; c++) {
      const at = depth === 0 ? 0.35 + (c / children) * 0.65 : 0.6 + rand() * 0.4;
      const from = start.clone().lerp(p, at);
      const spread = (depth === 0 ? 0.7 : 0.55) + rand() * 0.35;
      const az = rand() * TAU;
      const nd = d.clone()
        .add(new THREE.Vector3(Math.cos(az) * spread, 0.15, Math.sin(az) * spread))
        .normalize();
      grow(from, nd, len * (0.55 + rand() * 0.2), rad * (0.75 - depth * 0.05), depth + 1);
    }
  };

  grow(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0, 1, 0), height * 0.55, trunkR, 0);
  return { geometry: b.build(), radius: trunkR + 0.15, walkRadius: trunkR + 0.15, kind: "bare" };
}

/** A dead spruce: broken top and stubby bare branches. */
export function buildSnag(seed: number, height: number): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  const r = height * 0.03;
  const top = new THREE.Vector3((rand() - 0.5) * 0.3, height, (rand() - 0.5) * 0.3);
  tube(b, rand, new THREE.Vector3(0, -0.5, 0), top, r, r * 0.45, 7, 0.4);
  const stubs = 10 + Math.floor(rand() * 10);
  for (let i = 0; i < stubs; i++) {
    const t = 0.25 + rand() * 0.7;
    const y = height * t;
    const az = rand() * TAU;
    const len = (0.4 + rand() * 1.4) * (1.1 - t);
    const start = new THREE.Vector3(top.x * t, y, top.z * t);
    const end = start.clone().add(new THREE.Vector3(Math.cos(az) * len, -0.15 * len, Math.sin(az) * len));
    tube(b, rand, start, end, r * 0.25, 0.01, 4, 0.7);
  }
  return { geometry: b.build(), radius: r + 0.15, walkRadius: r + 0.15, kind: "snag" };
}

/** A lumpy drift over a buried bush or rock. */
export function buildMound(seed: number, size: number): TreeVariant {
  const rand = mulberry32(seed);
  const ico = new THREE.IcosahedronGeometry(1, 3);
  ico.deleteAttribute("uv");
  ico.deleteAttribute("normal");
  const geo = mergeVertices(ico);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors: number[] = [];
  const bumps = Array.from({ length: 5 }, () => ({
    d: new THREE.Vector3(rand() - 0.5, rand() * 0.5, rand() - 0.5).normalize(),
    s: 0.1 + rand() * 0.2
  }));
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    let r = 1;
    for (const bump of bumps) r += bump.s * Math.max(0, v.dot(bump.d)) ** 3;
    v.multiplyScalar(r);
    v.y = v.y > 0 ? v.y * 0.45 : v.y * 0.2;
    v.multiplyScalar(size);
    pos.setXYZ(i, v.x, v.y - size * 0.12, v.z);
    // Occasional dark twigs poking through on the underside.
    const g = v.y < size * 0.05 && rand() < 0.25 ? 0.25 : mix(0.82, SNOW, rand());
    const lin = Math.pow(g, 2.2);
    colors.push(lin, lin, lin);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute("matter", new THREE.Float32BufferAttribute(new Array<number>(pos.count).fill(MATTER.snow), 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  // The drift's height, and its typical footprint: the median radius of the ring where it meets
  // the ground. (The widest point would include the bumps, and lift the walker before the snow does.)
  let top = 0;
  for (let i = 0; i < pos.count; i++) top = Math.max(top, pos.getY(i));
  const edge: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y >= 0 && y < top * 0.15) edge.push(Math.hypot(pos.getX(i), pos.getZ(i)));
  }
  edge.sort((a, b) => a - b);
  const reach = edge.length > 0 ? edge[edge.length >> 1] : size;
  return { geometry: geo, radius: size * 0.6, walkRadius: size * 0.6, climb: { top, reach }, kind: "mound" };
}

/** A leafless bush: thin stems fanning out of the snow, forking once or twice. */
export function buildBush(seed: number, size: number): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  const stems = 6 + Math.floor(rand() * 5);
  for (let i = 0; i < stems; i++) {
    const az = rand() * TAU;
    const lean = 0.15 + rand() * 0.6;
    const len = size * (0.6 + rand() * 0.5);
    const out = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const p0 = new THREE.Vector3((rand() - 0.5) * 0.25, -0.3, (rand() - 0.5) * 0.25);
    const p1 = p0.clone().addScaledVector(out, Math.sin(lean) * len * 0.5);
    p1.y += Math.cos(lean) * len * 0.5 + 0.3;
    const p2 = p1.clone().addScaledVector(out, Math.sin(lean + 0.2) * len * 0.5);
    p2.y += Math.cos(lean + 0.2) * len * 0.5;
    tube(b, rand, p0, p1, 0.022, 0.015, 3, 0.2);
    tube(b, rand, p1, p2, 0.015, 0.005, 3, 0.3);
    const forks = 1 + Math.floor(rand() * 2);
    for (let k = 0; k < forks; k++) {
      const from = p0.clone().lerp(p1, 0.55 + rand() * 0.45);
      const fa = az + (rand() - 0.5) * 2.2;
      const fl = len * (0.3 + rand() * 0.3);
      const to = from.clone().add(new THREE.Vector3(Math.cos(fa) * fl * 0.6, fl * 0.8, Math.sin(fa) * fl * 0.6));
      tube(b, rand, from, to, 0.012, 0.004, 3, 0.3);
    }
  }
  return { geometry: b.build(), radius: 0, walkRadius: 0, kind: "bush" };
}

/** Dry grass standing out of the snow: a tuft of thin bent blades. */
export function buildGrass(seed: number, size: number): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  b.matter = MATTER.straw;
  const blades = 8 + Math.floor(rand() * 7);
  for (let i = 0; i < blades; i++) {
    const az = rand() * TAU;
    const x = (rand() - 0.5) * 0.35 * size;
    const z = (rand() - 0.5) * 0.35 * size;
    const h = size * (0.35 + rand() * 0.45);
    const lean = 0.1 + rand() * 0.5;
    const w = 0.012 + rand() * 0.012;
    // Across the blade, and the way it leans.
    const ax = Math.cos(az + Math.PI / 2) * w;
    const az2 = Math.sin(az + Math.PI / 2) * w;
    const lx = Math.cos(az) * h;
    const lz = Math.sin(az) * h;
    const g = 0.36 + rand() * 0.2;
    const a = b.vertex(x - ax, -0.15, z - az2, g * 0.8);
    const c = b.vertex(x + ax, -0.15, z + az2, g * 0.8);
    const ma = b.vertex(x - ax * 0.7 + lx * lean * 0.3, h * 0.6, z - az2 * 0.7 + lz * lean * 0.3, g);
    const mc = b.vertex(x + ax * 0.7 + lx * lean * 0.3, h * 0.6, z + az2 * 0.7 + lz * lean * 0.3, g);
    const tip = b.vertex(x + lx * lean, h * (1 - lean * 0.35), z + lz * lean, g * 1.15);
    b.tri(a, c, mc);
    b.tri(a, mc, ma);
    b.tri(ma, mc, tip);
  }
  return { geometry: b.build(), radius: 0, walkRadius: 0, kind: "grass" };
}

/** What is left of a snapped tree: a splintered stump under a cap of snow. */
export function buildStump(seed: number, height: number): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  const r = 0.2 + rand() * 0.16;
  const side = windSide(rand);
  const sides = 7;
  const ys = [-0.6, 0.05, 0.3, height];
  const radii = [r * 1.5, r * 1.3, r, r * 0.92];
  limb(
    b,
    rand,
    ys.map((y) => new THREE.Vector3(0, y, 0)),
    radii,
    sides,
    (_, radial) => barkGray(rand, radial, side, 0.5)
  );
  // Splinters round the break, pale where the wood is fresh.
  const tips: number[] = [];
  const rimR = r * 0.9;
  const off = rand() * TAU;
  for (let k = 0; k < sides; k++) {
    const a = off + (k / sides) * TAU;
    tips.push(b.vertex(Math.cos(a) * rimR, height + (rand() < 0.3 ? 0.06 + rand() * 0.14 : 0.02), Math.sin(a) * rimR, mix(0.2, 0.42, rand())));
  }
  const heart = b.vertex(0, height - 0.05, 0, 0.35);
  for (let k = 0; k < sides; k++) b.tri(heart, tips[(k + 1) % sides], tips[k]);
  // The snow on it: a low dome, a little to one side.
  const dome = r * (0.9 + rand() * 0.25);
  const cx = (rand() - 0.5) * r * 0.3;
  const cz = (rand() - 0.5) * r * 0.3;
  b.matter = MATTER.snow;
  const peak = b.vertex(cx, height + r * (0.45 + rand() * 0.3), cz, SNOW);
  const ring: number[] = [];
  const skirt: number[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    ring.push(b.vertex(cx + Math.cos(a) * dome * 0.6, height + r * 0.32, cz + Math.sin(a) * dome * 0.6, mix(0.85, SNOW, rand())));
    skirt.push(b.vertex(cx + Math.cos(a) * dome, height + 0.01, cz + Math.sin(a) * dome, mix(0.75, 0.9, rand())));
  }
  for (let k = 0; k < 8; k++) {
    const j = (k + 1) % 8;
    b.tri(peak, ring[j], ring[k]);
    b.tri(ring[k], ring[j], skirt[j]);
    b.tri(ring[k], skirt[j], skirt[k]);
  }
  return { geometry: b.build(), radius: r + 0.2, walkRadius: r + 0.1, kind: "stump" };
}

/** A boulder: a few dozen flat faces, the upward ones under snow. */
export function buildRock(seed: number, size: number): TreeVariant {
  const rand = mulberry32(seed);
  const ico = new THREE.IcosahedronGeometry(1, 1);
  ico.deleteAttribute("uv");
  ico.deleteAttribute("normal");
  const welded = mergeVertices(ico);
  const wp = welded.attributes.position as THREE.BufferAttribute;
  const sx = 0.8 + rand() * 0.5;
  const sz = 0.8 + rand() * 0.5;
  const sy = 0.55 + rand() * 0.3;
  for (let i = 0; i < wp.count; i++) {
    const k = size * (0.85 + rand() * 0.25);
    wp.setXYZ(i, wp.getX(i) * k * sx, wp.getY(i) * k * sy + size * sy * 0.45, wp.getZ(i) * k * sz);
  }
  // Unshared vertices: each face is flat and has its own colour.
  const geo = welded.toNonIndexed();
  geo.computeVertexNormals();
  const normals = geo.attributes.normal as THREE.BufferAttribute;
  const colors: number[] = [];
  for (let f = 0; f < normals.count; f += 3) {
    const up = normals.getY(f);
    const stone = 0.26 + rand() * 0.16;
    const g = up > 0.45 ? mix(0.84, SNOW, rand()) : up > 0.15 && rand() < 0.5 ? mix(0.6, 0.85, rand()) : stone;
    const lin = Math.pow(g, 2.2);
    for (let k = 0; k < 3; k++) colors.push(lin, lin, lin);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute("matter", new THREE.Float32BufferAttribute(new Array<number>(normals.count).fill(MATTER.rock), 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  const reach = size * Math.max(sx, sz) * 0.95;
  return { geometry: geo, radius: reach, walkRadius: reach * 0.9, kind: "rock" };
}

export function buildVariants(seed: number): TreeVariant[] {
  const rand = mulberry32(seed);
  const s = () => Math.floor(rand() * 1e9);
  return [
    buildSpruce(s(), 10),
    buildSpruce(s(), 12.5),
    buildSpruce(s(), 14),
    buildSpruce(s(), 16.5),
    buildSpruce(s(), 19),
    buildSpruce(s(), 11, { slim: true }),
    buildSpruce(s(), 15, { slim: true }),
    buildSpruce(s(), 15.5, { ragged: true }),
    buildSpruce(s(), 20, { ragged: true }),
    buildSpruce(s(), 1.4, { young: true }),
    buildSpruce(s(), 2.3, { young: true }),
    buildSpruce(s(), 3.4, { young: true }),
    buildPine(s(), 13),
    buildPine(s(), 16.5),
    buildPine(s(), 20),
    buildBirch(s(), 8.5),
    buildBirch(s(), 11),
    buildBirch(s(), 13.5),
    buildBareTree(s(), 11),
    buildBareTree(s(), 14),
    buildSnag(s(), 8),
    buildSnag(s(), 11.5),
    buildMound(s(), 0.9),
    buildMound(s(), 1.6),
    buildBush(s(), 1.1),
    buildBush(s(), 1.6),
    buildGrass(s(), 0.8),
    buildGrass(s(), 1.1),
    buildStump(s(), 0.45),
    buildStump(s(), 0.85),
    buildRock(s(), 0.7),
    buildRock(s(), 1.1),
    buildRock(s(), 1.6)
  ];
}
