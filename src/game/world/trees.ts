import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { mulberry32 } from "../lib/noise";

/**
 * What a vertex is made of. The grays say how light it is; in colour, this says
 * which hue the gray takes. Wood is what anything is unless told otherwise.
 */
export const MATTER = {
  /** Bark, logs, twigs: cold dark brown, with snow on it where the gray is pale. */
  wood: 0,
  /** Needles: cold dark conifer green, with snow on them where the gray is pale. */
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
  birch: 6,
  /** Upper Scots pine bark: muted coppery ochre, with snow only where very pale. */
  pineBark: 7,
  /** Aspen bark: smooth pale olive-ash grey, with dark knot scars. */
  aspen: 8
} as const;

/** Accumulates indexed triangles with per-vertex grayscale colour, material tag and wind flexibility. */
export class GeoBuilder {
  positions: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  /** What the vertices added from now on are made of: one of MATTER. */
  matter: number = MATTER.wood;
  /** Wind sway multiplier for vertices added from now on (0 = rigid stone/stump, 1 = normal, >1 = supple). */
  flex = 1;
  private matters: number[] = [];
  private flexes: number[] = [];

  vertex(x: number, y: number, z: number, gray: number): number {
    const lin = Math.pow(Math.min(1, Math.max(0, gray)), 2.2);
    this.positions.push(x, y, z);
    this.colors.push(lin, lin, lin);
    this.matters.push(this.matter);
    this.flexes.push(this.flex);
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
    if (this.flexes.some((f) => f !== 0)) geo.setAttribute("flex", new THREE.Float32BufferAttribute(this.flexes, 1));
    geo.setIndex(this.indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

export const TAU = Math.PI * 2;
export const BARK = 0.13;
const NEEDLE = 0.095;
export const SNOW = 0.93;

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Tapered tube between two points; top-facing vertices collect snow according to `snowiness`. */
export function tube(
  b: GeoBuilder,
  rand: () => number,
  start: THREE.Vector3,
  end: THREE.Vector3,
  r0: number,
  r1: number,
  sides: number,
  snowiness: number,
  bark = BARK
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
    const snowy = snowiness > 0 && up > 0.42 - snowiness * 0.28 && rand() < 0.25 + snowiness * 0.65;
    const c = snowy ? mix(0.6, SNOW, rand()) : bark * (0.75 + rand() * 0.5);
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
 * A conifer tier gets in the walker's way only if its branch tips hang below this
 * height (unscaled), and then only its inner, denser part: the walker brushes
 * through the outer tips, so a gap that looks passable is.
 */
const WALK_TIER_LOW = 3.1;
const WALK_TIER_REACH = 0.72;

export type TreeKind =
  | "fir"
  | "spruce"
  | "subSpruce"
  | "young"
  | "cedar"
  | "pine"
  | "larch"
  | "birch"
  | "birchClump"
  | "aspen"
  | "snag"
  | "birchSnag"
  | "mound"
  | "bush"
  | "tallBush"
  | "grass"
  | "stump"
  | "rock";

export interface TreeVariant {
  geometry: THREE.BufferGeometry;
  /** Collision radius at eye height, in unscaled units (deer keep clear of it). */
  radius: number;
  /** What the walker bumps into, in unscaled units: smaller, as it can push through branch tips. */
  walkRadius: number;
  /** Mounds only: the drift's shape, for walking over it. Unscaled, above its base. */
  climb?: { top: number; reach: number };
  /** True when the crown is wind-flagged along local +X so World can align its yaw with the prevailing wind. */
  flagged?: boolean;
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
  gray: (ring: number, radial: THREE.Vector3) => number,
  matterAt?: (ring: number) => number
): void {
  const dir = new THREE.Vector3();
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  const radial = new THREE.Vector3();
  const helper = new THREE.Vector3();
  const offset = rand() * TAU;
  const savedMatter = b.matter;
  let prev: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (matterAt) b.matter = matterAt(i);
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
  b.matter = savedMatter;
}

/** Natural bark tone without baked windward snow (windward snow plastering is applied in world space by the shader). */
function barkTone(rand: () => number, bark = BARK): number {
  return bark * (0.75 + rand() * 0.5);
}

/** Stubs of dead branches along a trunk, drooped and mostly wind-scoured. */
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
    const len = 0.28 + rand() * 0.75;
    const end = start.clone().add(new THREE.Vector3(Math.cos(az) * len, -(0.06 + rand() * 0.22) * len, Math.sin(az) * len));
    tube(b, rand, start, end, r, 0.008, 4, 0.22);
  }
}

/** A low snow collar tucked around the root flare of a big trunk or multi-stem clump. */
function snowCollar(b: GeoBuilder, rand: () => number, rBase: number, height: number): void {
  const beforeMatter = b.matter;
  const beforeFlex = b.flex;
  b.matter = MATTER.snow;
  b.flex = 0;
  const sides = 8;
  const top: number[] = [];
  const rim: number[] = [];
  const off = rand() * TAU;
  for (let k = 0; k < sides; k++) {
    const a = off + (k / sides) * TAU;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const r0 = rBase * (0.88 + rand() * 0.18);
    const r1 = rBase * (1.75 + rand() * 0.55);
    top.push(b.vertex(ca * r0, height * (0.8 + rand() * 0.35), sa * r0, mix(0.86, SNOW, rand())));
    rim.push(b.vertex(ca * r1, -0.18, sa * r1, mix(0.8, 0.91, rand())));
  }
  for (let k = 0; k < sides; k++) {
    const j = (k + 1) % sides;
    b.tri(top[k], rim[k], rim[j]);
    b.tri(top[k], rim[j], top[j]);
  }
  b.matter = beforeMatter;
  b.flex = beforeFlex;
}

/**
 * Shared jagged conifer branch tier: wind-scoured graphic profile where upper tiers
 * expose crisp dark needles while lower sheltered tiers hold snow cushions.
 */
function coniferTier(
  b: GeoBuilder,
  rand: () => number,
  c: THREE.Vector3,
  y: number,
  R: number,
  droop: number,
  lift: number,
  tierSnow: number,
  flag: number,
  tilt: number
): void {
  const K = Math.max(6, Math.round(6 + R * 2.5));
  const M = K * 2;
  const rot = rand() * TAU;
  const tx = (rand() - 0.5) * tilt;
  const tz = (rand() - 0.5) * tilt;
  const at = (x: number, yy: number, z: number, gray: number) => b.vertex(c.x + x, yy + x * tx + z * tz, c.z + z, gray);

  const top = at(0, y + lift, 0, mix(NEEDLE, SNOW, Math.min(1, tierSnow * 1.15)));
  const inner: number[] = [];
  const rimTop: number[] = [];
  const rimBottom: number[] = [];
  for (let j = 0; j < M; j++) {
    const tip = j % 2 === 0;
    const a = rot + (j / M) * TAU + (rand() - 0.5) * (TAU / M) * 0.6;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // Flagged branches stretch downwind along local +X (ca > 0).
    const reach = 1 + flag * ca;
    const ri = R * (0.42 + rand() * 0.12);
    const yi = y + lift * 0.28 - droop * 0.12;
    const innerSnow = rand() < tierSnow ? mix(0.68, SNOW, rand()) : mix(NEEDLE, 0.36, rand());
    inner.push(at(ca * ri, yi, sa * ri, innerSnow));

    const ro = (tip ? R * (0.85 + rand() * 0.32) : R * (0.48 + rand() * 0.16)) * reach;
    const yo = tip ? y - droop * (0.78 + rand() * 0.42) : y - droop * 0.42;
    // Wind-scoured outer tips stay dark and graphic except on very snowy lower tiers.
    const tipSnowChance = tierSnow * 0.32;
    const rimSnow = tip
      ? rand() < tipSnowChance ? mix(0.5, 0.82, rand()) : NEEDLE * (0.7 + rand() * 0.55)
      : rand() < tierSnow * 0.75 ? mix(0.58, SNOW, rand()) : mix(NEEDLE, 0.26, rand());
    rimTop.push(at(ca * ro, yo, sa * ro, rimSnow));
    rimBottom.push(at(ca * ro, yo - 0.02, sa * ro, NEEDLE * (0.5 + rand() * 0.55)));
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

/**
 * Siberian Fir (Abies sibirica — пихта сибирская): ultra-narrow needle spire,
 * dense steeply drooping branches almost to the snow, wind-scoured crisp dark upper half.
 */
export function buildFir(seed: number, height: number): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  b.flex = 0.75;
  const H = height;
  const trunkR = 0.055 + H * 0.01;
  const bendA = rand() * TAU;
  const bend = H * (0.004 + rand() * 0.014);
  const axis = (y: number) => {
    const k = bend * (Math.max(0, y) / H) ** 2;
    return new THREE.Vector3(Math.cos(bendA) * k, y, Math.sin(bendA) * k);
  };
  const ys = [-0.6, H * 0.25, H * 0.55, H * 0.85, H * 0.96];
  limb(
    b,
    rand,
    ys.map(axis),
    ys.map((_, i) => trunkR * mix(1, 0.14, i / (ys.length - 1))),
    6,
    () => barkTone(rand, 0.11)
  );

  const crownBase = Math.max(0.55, H * (0.04 + rand() * 0.05));
  const rMax = H * (0.088 + rand() * 0.026);
  const tiers = Math.max(10, Math.round(H * 2.0 + rand() * 3));
  let radiusAtEye = trunkR;
  let walkRadius = trunkR + 0.12;

  b.matter = MATTER.needle;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = crownBase + (H * 0.96 - crownBase) * Math.pow(t, 0.94);
    const R = rMax * Math.pow(1 - t, 0.78) * (0.84 + rand() * 0.32) + 0.09;
    const droop = R * (0.95 + rand() * 0.45);
    const lift = R * 0.14;
    // Wind-scoured profile: snowy lower skirt, crisp dark upper needle spire.
    const shelter = Math.pow(1 - t, 1.55);
    const tierSnow = (0.14 + 0.68 * shelter) * (0.75 + rand() * 0.25);
    if (y - droop * 1.15 < 4.6) radiusAtEye = Math.max(radiusAtEye, R * 1.05);
    if (y - droop * 1.15 < WALK_TIER_LOW) walkRadius = Math.max(walkRadius, R * WALK_TIER_REACH);
    coniferTier(b, rand, axis(y), y, R, droop, lift, tierSnow, 0.06, 0.1);
  }

  // Sharp dark spire leader.
  const tip = axis(H * 1.04);
  tube(b, rand, axis(H * 0.92), tip, 0.055, 0.008, 4, 0.12, NEEDLE);

  const radius = Math.max(trunkR + 0.15, radiusAtEye);
  return { geometry: b.build(), radius, walkRadius: Math.min(radius, walkRadius), kind: "fir" };
}

export interface SpruceShape {
  /** A sapling (1.2–3.2 m): snowy lower skirt with a dark spire tip poking above the drift. */
  young?: boolean;
  /** A second-tier shade-grown spruce (4.5–8.5 m) under birch/pine canopies. */
  sub?: boolean;
  /** An old wind-beaten spruce: high thin crown with gaps, dead stubs, downwind flagging. */
  ragged?: boolean;
}

/** Siberian Spruce (Picea obovata — сибирская ель): narrower than European spruce, wind-scoured graphic upper crown. */
export function buildSpruce(seed: number, height: number, { young = false, sub = false, ragged = false }: SpruceShape = {}): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  b.flex = young || sub ? 0.9 : 0.8;
  const H = height;
  const trunkR = 0.06 + H * 0.011;
  const bendA = ragged ? (rand() - 0.5) * 0.7 : rand() * TAU;
  const bend = young ? 0 : H * (0.006 + rand() * (ragged ? 0.035 : 0.018));
  const axis = (y: number) => {
    const k = bend * (Math.max(0, y) / H) ** 2;
    return new THREE.Vector3(Math.cos(bendA) * k, y, Math.sin(bendA) * k);
  };
  const ys = [-0.6, H * 0.2, H * 0.45, H * 0.7, H * 0.92];
  limb(
    b,
    rand,
    ys.map(axis),
    ys.map((_, i) => trunkR * mix(1, 0.18, i / (ys.length - 1))),
    6,
    () => barkTone(rand, BARK)
  );
  if (!young && !sub && H > 14) snowCollar(b, rand, trunkR * 1.1, 0.3 + rand() * 0.2);

  const crownBase = young
    ? H * 0.06
    : sub
      ? Math.max(0.7, H * (0.1 + rand() * 0.08))
      : ragged
        ? H * (0.28 + rand() * 0.12)
        : Math.max(1.3, H * (0.12 + rand() * 0.12));
  const rMax = H * (young ? 0.26 + rand() * 0.07 : sub ? 0.15 + rand() * 0.04 : ragged ? 0.18 + rand() * 0.05 : 0.155 + rand() * 0.045);
  const tiers = Math.max(5, Math.round(H * (young ? 2.4 : sub ? 1.7 : ragged ? 1.05 : 1.55) + rand() * 3));
  const flag = young ? 0 : ragged ? 0.24 + rand() * 0.22 : sub ? 0.05 : 0.08 + rand() * 0.12;
  let radiusAtEye = trunkR;
  let walkRadius = trunkR + 0.12;

  b.matter = MATTER.needle;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = crownBase + (H * 0.95 - crownBase) * Math.pow(t, 0.92);
    const R = rMax * Math.pow(1 - t, 0.82) * (ragged ? 0.58 + rand() * 0.72 : 0.82 + rand() * 0.36) + 0.11;
    const droop = R * (0.45 + rand() * 0.28);
    const lift = R * 0.16;
    if (ragged && i > 0 && i < tiers - 2 && rand() < 0.18) continue;
    // Wind-scoured gradient: upper tiers dark and graphic, lower sheltered skirts carry snow.
    const shelter = Math.pow(1 - t, young ? 1.25 : 1.6);
    const baseSnow = young ? 0.76 : ragged ? 0.42 : 0.62;
    const tierSnow = (0.08 + baseSnow * shelter) * (0.75 + rand() * 0.25);
    if (y - droop * 1.2 < 4.6) radiusAtEye = Math.max(radiusAtEye, R * 1.05);
    if (y - droop * 1.2 < WALK_TIER_LOW) walkRadius = Math.max(walkRadius, R * WALK_TIER_REACH);
    coniferTier(b, rand, axis(y), y, R, droop, lift, tierSnow, flag, young ? 0.06 : 0.14);
  }

  if (!young) {
    const count = ragged ? 7 + Math.floor(rand() * 6) : sub ? 2 + Math.floor(rand() * 2) : 3 + Math.floor(rand() * 4);
    b.matter = MATTER.wood;
    stubs(b, rand, axis, count, 0.8, Math.max(1.4, crownBase + (ragged ? H * 0.2 : 0.5)), trunkR * 0.22);
    b.matter = MATTER.needle;
  }

  const tip = axis(H * 1.03);
  tip.x += (rand() - 0.5) * 0.08;
  tube(b, rand, axis(H * 0.9), tip, 0.065, 0.01, 4, 0.18, NEEDLE);

  const radius = Math.max(trunkR + 0.15, radiusAtEye);
  return {
    geometry: b.build(),
    radius,
    walkRadius: Math.min(radius, walkRadius),
    flagged: ragged,
    kind: young ? "young" : sub ? "subSpruce" : "spruce"
  };
}

/**
 * A flatter, jagged horizontal needle plate for Scots pine and Siberian cedar boughs:
 * wind-scoured dark rim and underside, snow tucked into the sheltered crown centre.
 */
function flatPad(
  b: GeoBuilder,
  rand: () => number,
  x: number,
  y: number,
  z: number,
  R: number,
  flatness: number,
  snowiness: number
): void {
  const M = 14;
  const h = R * flatness * (0.85 + rand() * 0.3);
  const rot = rand() * TAU;
  const before = b.matter;
  b.matter = MATTER.needle;
  const top = b.vertex(x, y + h, z, mix(NEEDLE, SNOW, snowiness));
  const inner: number[] = [];
  const rimTop: number[] = [];
  const rimBottom: number[] = [];
  for (let j = 0; j < M; j++) {
    const tip = j % 2 === 0;
    const a = rot + (j / M) * TAU + (rand() - 0.5) * (TAU / M) * 0.65;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const ri = R * (0.5 + rand() * 0.16);
    inner.push(
      b.vertex(
        x + ca * ri,
        y + h * (0.55 + rand() * 0.22),
        z + sa * ri,
        rand() < snowiness * 0.85 ? mix(0.62, SNOW, rand()) : mix(NEEDLE, 0.32, rand())
      )
    );
    const ro = tip ? R * (0.95 + rand() * 0.25) : R * (0.64 + rand() * 0.16);
    const yo = tip ? y - R * (0.04 + rand() * 0.1) : y + h * 0.12;
    const gray = tip
      ? rand() < snowiness * 0.22 ? mix(0.45, 0.78, rand()) : NEEDLE * (0.68 + rand() * 0.55)
      : rand() < snowiness * 0.6 ? mix(0.55, SNOW, rand()) : mix(NEEDLE, 0.24, rand());
    rimTop.push(b.vertex(x + ca * ro, yo, z + sa * ro, gray));
    rimBottom.push(b.vertex(x + ca * ro, yo - 0.02, z + sa * ro, NEEDLE * (0.48 + rand() * 0.52)));
  }
  const bottom = b.vertex(x, y - R * 0.12, z, NEEDLE * 0.48);
  for (let j = 0; j < M; j++) {
    const k = (j + 1) % M;
    b.tri(top, inner[k], inner[j]);
    b.tri(inner[j], rimTop[k], rimTop[j]);
    b.tri(inner[j], inner[k], rimTop[k]);
    b.tri(bottom, rimBottom[j], rimBottom[k]);
  }
  b.matter = before;
}

/**
 * Siberian Pine / "Cedar" (Pinus sibirica — сибирский кедр): massive trunk,
 * broad dark ovoid/cylindrical crown starting around 0.38 H with heavy boughs and
 * a rounded or candelabra twin top.
 */
export function buildCedar(seed: number, height: number): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  b.flex = 0.45;
  const H = height;
  const r0 = 0.14 + H * 0.015;
  const bendA = (rand() - 0.5) * 0.8;
  const bend = H * (0.008 + rand() * 0.02);
  const axis = (y: number) => {
    const t = Math.max(0, y) / H;
    const k = bend * t * t;
    return new THREE.Vector3(Math.cos(bendA) * k, y, Math.sin(bendA) * k);
  };
  const top = H * 0.92;
  const ys = [-0.6, 0.4, H * 0.18, H * 0.38, H * 0.58, H * 0.76, top];
  const radiusAt = (y: number) => r0 * (y < 0.5 ? 1.2 : 1) * mix(1, 0.22, Math.pow(Math.max(0, y) / top, 1.15));
  limb(b, rand, ys.map(axis), ys.map(radiusAt), 7, () => barkTone(rand, 0.12));
  snowCollar(b, rand, r0 * 1.25, 0.38 + rand() * 0.2);
  stubs(b, rand, axis, 4 + Math.floor(rand() * 4), H * 0.12, H * 0.38, r0 * 0.22);

  const boughs = 16 + Math.floor(rand() * 5);
  const turn = rand() * TAU;
  for (let i = 0; i < boughs; i++) {
    const t = i / (boughs - 1);
    const y0 = H * mix(0.36, 0.9, t) + (rand() - 0.5) * H * 0.025;
    const az = turn + i * 2.399 + (rand() - 0.5) * 0.5;
    // Broad ovoid profile: widest through the middle of the crown, full at top.
    const profile = Math.sin(Math.pow(t, 0.75) * Math.PI * 0.85 + 0.28);
    const len = H * (0.14 + 0.11 * profile) * (0.8 + rand() * 0.4);
    const rise = len * mix(0.05, 0.55, t);
    const out = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const start = axis(y0);
    const mid = start.clone().addScaledVector(out, len * 0.55);
    mid.y += rise * 0.35;
    const end = start.clone().addScaledVector(out, len);
    end.y += rise;
    const r = Math.max(0.035, radiusAt(y0) * 0.46);
    tube(b, rand, start, mid, r, r * 0.65, 5, 0.3);
    tube(b, rand, mid, end, r * 0.65, 0.03, 4, 0.22);
    // Sheltered lower/inner clumps hold snow; upper outer crown stays dark and dramatic.
    const snow = (0.14 + 0.42 * Math.pow(1 - t, 1.3)) * (0.8 + rand() * 0.35);
    const R = H * (0.085 + rand() * 0.035) * (0.75 + 0.35 * profile);
    flatPad(b, rand, end.x, end.y, end.z, R, 0.38, snow);
    flatPad(b, rand, mid.x, mid.y + 0.15, mid.z, R * 0.85, 0.42, Math.min(0.8, snow * 1.35));
  }
  // Rounded / twin candelabra crown apex.
  const apex = axis(top);
  const twin = rand() < 0.5;
  if (twin) {
    for (const s of [-1, 1]) {
      const a = turn + (s > 0 ? 0 : Math.PI);
      const p = apex.clone().add(new THREE.Vector3(Math.cos(a) * H * 0.055, H * 0.06, Math.sin(a) * H * 0.055));
      tube(b, rand, apex, p, r0 * 0.22, 0.04, 4, 0.15);
      flatPad(b, rand, p.x, p.y, p.z, H * 0.095, 0.42, 0.2);
    }
  } else {
    flatPad(b, rand, apex.x, apex.y + H * 0.03, apex.z, H * 0.11, 0.44, 0.22);
  }

  return { geometry: b.build(), radius: r0 + 0.2, walkRadius: r0 + 0.18, flagged: true, kind: "cedar" };
}

/**
 * Scots Pine (Pinus sylvestris — сосна обыкновенная): tall clean mast trunk with
 * dark furrowed lower bark and warm coppery-ochre upper bark, topped by flat jagged
 * horizontal needle plates.
 */
export function buildPine(seed: number, height: number): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  b.flex = 0.5;
  const H = height;
  const r0 = 0.1 + H * 0.012;
  const bendA = (rand() - 0.5) * 0.9;
  const bend = H * (0.01 + rand() * 0.032);
  const wobble = rand() * TAU;
  const axis = (y: number) => {
    const t = Math.max(0, y) / H;
    const k = bend * t * t + Math.sin(t * 5 + wobble) * 0.012 * H * t;
    return new THREE.Vector3(Math.cos(bendA) * k, y, Math.sin(bendA) * k);
  };
  const top = H * 0.94;
  const ys = [-0.6, H * 0.12, H * 0.28, H * 0.44, H * 0.6, H * 0.74, H * 0.86, top];
  const radiusAt = (y: number) => r0 * mix(1, 0.2, Math.pow(Math.max(0, y) / top, 1.3));
  limb(
    b,
    rand,
    ys.map(axis),
    ys.map(radiusAt),
    6,
    (i) => barkTone(rand, ys[i] > H * 0.42 ? 0.28 : BARK),
    (i) => (ys[i] > H * 0.42 ? MATTER.pineBark : MATTER.wood)
  );
  stubs(b, rand, axis, 3 + Math.floor(rand() * 4), H * 0.25, H * 0.6, r0 * 0.2);

  b.matter = MATTER.pineBark;
  const boughs = 9 + Math.floor(rand() * 4);
  const turn = rand() * TAU;
  for (let i = 0; i < boughs; i++) {
    const t = i / (boughs - 1);
    const y0 = H * mix(0.62, 0.91, t) + (rand() - 0.5) * H * 0.025;
    const az = turn + i * 2.399 + (rand() - 0.5) * 0.7;
    // Slight downwind stretch along local +X.
    const flag = 1 + 0.18 * Math.cos(az);
    const len = H * mix(0.24, 0.11, t) * (0.78 + rand() * 0.44) * flag;
    const rise = len * (0.14 + rand() * 0.26);
    const out = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const start = axis(y0);
    const mid = start.clone().addScaledVector(out, len * 0.55);
    mid.y += rise * 0.2;
    const end = start.clone().addScaledVector(out, len);
    end.y += rise;
    const r = radiusAt(y0) * 0.48;
    tube(b, rand, start, mid, r, r * 0.6, 5, 0.22, 0.26);
    tube(b, rand, mid, end, r * 0.6, 0.03, 4, 0.18, 0.26);
    // Flat horizontal wind-scoured pine plates.
    const snow = (0.12 + 0.34 * (1 - t)) * (0.75 + rand() * 0.35);
    const R = H * (0.09 + rand() * 0.045) * (1 - t * 0.22);
    flatPad(b, rand, end.x, end.y, end.z, R, 0.27, snow);
    if (len > H * 0.14) flatPad(b, rand, mid.x, mid.y + 0.08, mid.z, R * 0.78, 0.28, snow * 1.15);
  }
  const apex = axis(top);
  flatPad(b, rand, apex.x, apex.y, apex.z, H * (0.1 + rand() * 0.03), 0.26, 0.16);

  return { geometry: b.build(), radius: r0 + 0.15, walkRadius: r0 + 0.15, flagged: true, kind: "pine" };
}

/**
 * Siberian Larch (Larix sibirica — сибирская лиственница): deciduous conifer bare in winter.
 * Straight mast trunk with buttress flare, tiered horizontal/swept-up branch whorls and
 * fine upright shoots — a crisp graphic lattice against the snow fog.
 */
export function buildLarch(seed: number, height: number): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  b.flex = 0.65;
  const H = height;
  const r0 = 0.1 + H * 0.012;
  const bendA = rand() * TAU;
  const bend = H * (0.005 + rand() * 0.016);
  const axis = (y: number) => {
    const t = Math.max(0, y) / H;
    const k = bend * t * t;
    return new THREE.Vector3(Math.cos(bendA) * k, y, Math.sin(bendA) * k);
  };
  const ys = [-0.6, 0.35, H * 0.18, H * 0.38, H * 0.58, H * 0.78, H * 0.94, H];
  const radiusAt = (y: number) => r0 * (y < 0.4 ? 1.4 : 1) * mix(1, 0.08, Math.pow(Math.max(0, y) / H, 1.05));
  limb(b, rand, ys.map(axis), ys.map(radiusAt), 6, () => barkTone(rand, 0.12));

  // Regular conifer whorls of bare drooping-then-upturned branches.
  const whorls = Math.max(8, Math.round(H * 0.65));
  const crownBase = H * (0.26 + rand() * 0.1);
  const turn = rand() * TAU;
  for (let w = 0; w < whorls; w++) {
    const t = w / (whorls - 1);
    const y0 = mix(crownBase, H * 0.93, t);
    const perWhorl = t > 0.78 ? 2 : 3 + (rand() < 0.45 ? 1 : 0);
    const rMax = H * (0.18 * Math.pow(1 - t * 0.85, 0.85)) * (0.85 + rand() * 0.3);
    for (let j = 0; j < perWhorl; j++) {
      const az = turn + w * 1.15 + (j / perWhorl) * TAU + (rand() - 0.5) * 0.45;
      const len = rMax * (0.75 + rand() * 0.45);
      const out = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
      const p0 = axis(y0 + (rand() - 0.5) * 0.25);
      // Droop gracefully in the middle, then sweep slightly upward at the tips.
      const p1 = p0.clone().addScaledVector(out, len * 0.55);
      p1.y -= len * (0.12 + rand() * 0.1) * (1 - t * 0.6);
      const p2 = p0.clone().addScaledVector(out, len);
      p2.y += len * (-0.04 + t * 0.26 + (rand() - 0.5) * 0.08);
      const r = Math.max(0.016, radiusAt(y0) * 0.42);
      const snow = 0.22 * (1 - t * 0.75);
      tube(b, rand, p0, p1, r, r * 0.58, 4, snow, 0.13);
      tube(b, rand, p1, p2, r * 0.58, 0.008, 3, snow * 0.5, 0.13);

      // Fine secondary shoots & twig forks along the bough.
      const twigs = t < 0.7 ? 2 + Math.floor(rand() * 2) : 1;
      for (let k = 0; k < twigs; k++) {
        const u = 0.35 + (k / twigs) * 0.55;
        const from = u < 0.5 ? p0.clone().lerp(p1, u * 2) : p1.clone().lerp(p2, (u - 0.5) * 2);
        const side = (k % 2 === 0 ? 1 : -1) * (0.55 + rand() * 0.45);
        const ta = az + side;
        const tl = len * (0.28 + rand() * 0.22);
        const to = from.clone().add(new THREE.Vector3(Math.cos(ta) * tl, tl * (0.12 + rand() * 0.22), Math.sin(ta) * tl));
        tube(b, rand, from, to, 0.013, 0.004, 3, 0.08, 0.14);
      }
    }
  }
  return { geometry: b.build(), radius: r0 + 0.18, walkRadius: r0 + 0.15, kind: "larch" };
}

/** Builds a single birch stem anchored at `base`, leaning outward along `leanA` by `leanAmp`. */
function addBirchStem(
  b: GeoBuilder,
  rand: () => number,
  base: THREE.Vector3,
  H: number,
  leanA: number,
  leanAmp: number
): number {
  const r0 = 0.065 + H * 0.0105;
  const bend = H * (0.02 + rand() * 0.055) + leanAmp;
  const axis = (y: number) => {
    const t = Math.max(0, y) / H;
    const k = bend * t * (0.45 + 0.55 * t);
    return new THREE.Vector3(base.x + Math.cos(leanA) * k, base.y + y, base.z + Math.sin(leanA) * k);
  };
  const radiusAt = (y: number) => r0 * mix(1, 0.09, Math.pow(Math.max(0, y) / H, 1.1));

  // Higher dark fissured bark "stocking" at the base, then pale bark ringed with dark lenticels.
  const stocking = 0.85 + rand() * 0.7;
  const ys: number[] = [-0.5];
  const dark: boolean[] = [false];
  for (let y = 0.25 + rand() * 0.3; y < H * 0.97; y += 0.48 + rand() * 0.55) {
    ys.push(y);
    dark.push(false);
    if (y > stocking * 0.7 && y < H * 0.78 && rand() < 0.58) {
      const w = 0.05 + rand() * 0.1;
      ys.push(y + 0.03, y + 0.03 + w, y + 0.06 + w);
      dark.push(true, true, false);
    }
  }
  ys.push(H * 0.97);
  dark.push(false);
  b.matter = MATTER.birch;
  limb(b, rand, ys.map(axis), ys.map(radiusAt), 6, (i) => {
    if (ys[i] < stocking) return mix(0.11, 0.32, rand());
    if (ys[i] > H * 0.82) return mix(0.1, 0.26, rand());
    return dark[i] && rand() < 0.78 ? 0.07 + rand() * 0.08 : mix(0.74, 0.9, rand());
  });
  b.matter = MATTER.wood;

  const branches = 13 + Math.floor(rand() * 6);
  const turn = rand() * TAU;
  for (let i = 0; i < branches; i++) {
    const t = i / (branches - 1);
    const y0 = H * mix(0.36, 0.91, t);
    const az = turn + i * 2.399 + (rand() - 0.5) * 0.8;
    const len = H * mix(0.3, 0.1, t) * (0.8 + rand() * 0.4);
    const open = 0.42 + rand() * 0.35;
    const out = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const p0 = axis(y0);
    const p1 = p0.clone().addScaledVector(out, Math.sin(open) * len * 0.5);
    p1.y += Math.cos(open) * len * 0.5;
    const p2 = p1.clone().addScaledVector(out, Math.sin(open + 0.35) * len * 0.5);
    p2.y += Math.cos(open + 0.35) * len * 0.5;
    const r = Math.max(0.018, radiusAt(y0) * 0.44);
    tube(b, rand, p0, p1, r, r * 0.58, 4, 0.25);
    tube(b, rand, p1, p2, r * 0.58, 0.011, 4, 0.18);
    // Fine weeping twig curtains.
    const twigs = 3 + Math.floor(rand() * 2);
    for (let k = 0; k < twigs; k++) {
      const from = p1.clone().lerp(p2, k === 0 ? 1 : 0.2 + rand() * 0.7);
      const ta = az + (rand() - 0.5) * 1.6;
      const tl = len * (0.34 + rand() * 0.32);
      const knee = from.clone().add(new THREE.Vector3(Math.cos(ta) * tl * 0.42, tl * 0.04, Math.sin(ta) * tl * 0.42));
      const end = knee.clone().add(new THREE.Vector3(Math.cos(ta) * tl * 0.18, -tl * 0.82, Math.sin(ta) * tl * 0.18));
      tube(b, rand, from, knee, 0.015, 0.01, 3, 0.15);
      tube(b, rand, knee, end, 0.01, 0.005, 3, 0.05);
    }
  }
  return r0;
}

/** A birch (single trunk or clonal 2–3 stem clump fanning out from a shared snow-collared base). */
export function buildBirch(seed: number, height: number, stems = 1): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  b.flex = 1.35;
  let reach = 0;
  if (stems <= 1) {
    const r0 = addBirchStem(b, rand, new THREE.Vector3(0, 0, 0), height, rand() * TAU, 0);
    reach = r0 + 0.15;
  } else {
    const baseOff = rand() * TAU;
    for (let s = 0; s < stems; s++) {
      const a = baseOff + (s / stems) * TAU + (rand() - 0.5) * 0.5;
      const dist = 0.16 + rand() * 0.14;
      const sh = height * (s === 0 ? 1 : 0.74 + rand() * 0.22);
      const r0 = addBirchStem(b, rand, new THREE.Vector3(Math.cos(a) * dist, 0, Math.sin(a) * dist), sh, a, 0.45 + rand() * 0.45);
      reach = Math.max(reach, dist + r0 + 0.16);
    }
    snowCollar(b, rand, reach * 0.9, 0.26 + rand() * 0.14);
  }
  return { geometry: b.build(), radius: reach, walkRadius: reach, kind: stems > 1 ? "birchClump" : "birch" };
}

/**
 * Aspen (Populus tremula — осина): tall straight columnar pale-grey-olive trunk
 * clean up to ~62% height, with a compact ascending crown of short crooked limbs.
 */
export function buildAspen(seed: number, height: number): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  b.flex = 1.25;
  const H = height;
  const r0 = 0.08 + H * 0.011;
  const bendA = rand() * TAU;
  const bend = H * (0.008 + rand() * 0.025);
  const axis = (y: number) => {
    const t = Math.max(0, y) / H;
    const k = bend * t * t;
    return new THREE.Vector3(Math.cos(bendA) * k, y, Math.sin(bendA) * k);
  };
  const top = H * 0.96;
  const radiusAt = (y: number) => r0 * mix(1, 0.12, Math.pow(Math.max(0, y) / top, 1.15));
  const ys = [-0.6, 0.6, H * 0.18, H * 0.36, H * 0.54, H * 0.7, H * 0.84, top];
  b.matter = MATTER.aspen;
  limb(b, rand, ys.map(axis), ys.map(radiusAt), 6, (i) => {
    // Dark fissured bark only near the foot; smooth pale olive-grey column above.
    if (ys[i] < 0.9) return mix(0.16, 0.3, rand());
    return mix(0.36, 0.49, rand());
  });

  // Compact ascending crown starting high on the column.
  const branches = 11 + Math.floor(rand() * 5);
  const turn = rand() * TAU;
  for (let i = 0; i < branches; i++) {
    const t = i / (branches - 1);
    const y0 = H * mix(0.56, 0.92, t);
    const az = turn + i * 2.399 + (rand() - 0.5) * 0.7;
    const len = H * mix(0.22, 0.09, t) * (0.8 + rand() * 0.4);
    const out = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const p0 = axis(y0);
    const steep = 0.48 + rand() * 0.3;
    const p1 = p0.clone().addScaledVector(out, Math.sin(steep) * len * 0.55);
    p1.y += Math.cos(steep) * len * 0.55;
    const p2 = p1.clone().addScaledVector(out, Math.sin(steep - 0.1) * len * 0.45);
    p2.y += Math.cos(steep - 0.1) * len * 0.45;
    const r = Math.max(0.018, radiusAt(y0) * 0.46);
    tube(b, rand, p0, p1, r, r * 0.55, 4, 0.22, 0.38);
    tube(b, rand, p1, p2, r * 0.55, 0.01, 3, 0.14, 0.32);

    const twigs = 2 + Math.floor(rand() * 2);
    for (let k = 0; k < twigs; k++) {
      const from = p0.clone().lerp(p2, 0.45 + rand() * 0.5);
      const ta = az + (rand() - 0.5) * 1.4;
      const tl = len * (0.3 + rand() * 0.25);
      const to = from.clone().add(new THREE.Vector3(Math.cos(ta) * tl * 0.5, tl * 0.85, Math.sin(ta) * tl * 0.5));
      tube(b, rand, from, to, 0.012, 0.005, 3, 0.1, 0.28);
    }
  }
  return { geometry: b.build(), radius: r0 + 0.15, walkRadius: r0 + 0.15, kind: "aspen" };
}

/** A dead conifer snag: broken splintered top and stubby bare branches. */
export function buildSnag(seed: number, height: number): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  b.flex = 0.2;
  const r = height * 0.03;
  const top = new THREE.Vector3((rand() - 0.5) * 0.3, height, (rand() - 0.5) * 0.3);
  tube(b, rand, new THREE.Vector3(0, -0.5, 0), top, r, r * 0.42, 7, 0.18);
  const count = 9 + Math.floor(rand() * 9);
  for (let i = 0; i < count; i++) {
    const t = 0.25 + rand() * 0.7;
    const y = height * t;
    const az = rand() * TAU;
    const len = (0.35 + rand() * 1.25) * (1.1 - t);
    const start = new THREE.Vector3(top.x * t, y, top.z * t);
    const end = start.clone().add(new THREE.Vector3(Math.cos(az) * len, -0.18 * len, Math.sin(az) * len));
    tube(b, rand, start, end, r * 0.25, 0.01, 4, 0.28);
  }
  return { geometry: b.build(), radius: r + 0.15, walkRadius: r + 0.15, kind: "snag" };
}

/** A snapped birch snag ("свеча"): pale ringed trunk broken off mid-height with a few dark knots. */
export function buildBirchSnag(seed: number, height: number): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  b.flex = 0.22;
  const H = height;
  const r0 = 0.11 + rand() * 0.06;
  const leanA = rand() * TAU;
  const bend = H * (0.02 + rand() * 0.05);
  const axis = (y: number) => {
    const t = Math.max(0, y) / H;
    return new THREE.Vector3(Math.cos(leanA) * bend * t, y, Math.sin(leanA) * bend * t);
  };
  const ys = [-0.5, 0.7, H * 0.28, H * 0.46, H * 0.62, H * 0.8, H];
  b.matter = MATTER.birch;
  limb(
    b,
    rand,
    ys.map(axis),
    ys.map((_, i) => r0 * mix(1, 0.58, i / (ys.length - 1))),
    6,
    (i) => (ys[i] < 0.85 ? mix(0.12, 0.28, rand()) : rand() < 0.28 ? 0.08 + rand() * 0.08 : mix(0.72, 0.88, rand()))
  );
  b.matter = MATTER.wood;
  stubs(b, rand, axis, 3 + Math.floor(rand() * 3), H * 0.45, H * 0.92, r0 * 0.2);
  return { geometry: b.build(), radius: r0 + 0.15, walkRadius: r0 + 0.15, kind: "birchSnag" };
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
    const g = v.y < size * 0.05 && rand() < 0.25 ? 0.25 : mix(0.82, SNOW, rand());
    const lin = Math.pow(g, 2.2);
    colors.push(lin, lin, lin);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute("matter", new THREE.Float32BufferAttribute(new Array<number>(pos.count).fill(MATTER.snow), 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
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

/** A leafless bush or tall creekside willow/alder thicket: thin stems fanning out of the snow. */
export function buildBush(seed: number, size: number, tall = false): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  b.flex = tall ? 1.35 : 1.45;
  const stems = tall ? 9 + Math.floor(rand() * 6) : 6 + Math.floor(rand() * 5);
  for (let i = 0; i < stems; i++) {
    const az = rand() * TAU;
    const lean = tall ? 0.18 + rand() * 0.52 : 0.15 + rand() * 0.6;
    const len = size * (0.65 + rand() * 0.45);
    const out = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const spread = tall ? 0.45 : 0.25;
    const p0 = new THREE.Vector3((rand() - 0.5) * spread, -0.3, (rand() - 0.5) * spread);
    const p1 = p0.clone().addScaledVector(out, Math.sin(lean) * len * 0.5);
    p1.y += Math.cos(lean) * len * 0.5 + 0.3;
    const p2 = p1.clone().addScaledVector(out, Math.sin(lean + 0.24) * len * 0.5);
    p2.y += Math.cos(lean + 0.24) * len * 0.5;
    const r0 = tall ? 0.032 : 0.022;
    tube(b, rand, p0, p1, r0, r0 * 0.62, 3, 0.15, tall ? 0.2 : BARK);
    tube(b, rand, p1, p2, r0 * 0.62, 0.005, 3, 0.12, tall ? 0.2 : BARK);
    const forks = 1 + Math.floor(rand() * (tall ? 3 : 2));
    for (let k = 0; k < forks; k++) {
      const from = p0.clone().lerp(p1, 0.5 + rand() * 0.48);
      const fa = az + (rand() - 0.5) * 2.2;
      const fl = len * (0.28 + rand() * 0.3);
      const to = from.clone().add(new THREE.Vector3(Math.cos(fa) * fl * 0.6, fl * 0.8, Math.sin(fa) * fl * 0.6));
      tube(b, rand, from, to, r0 * 0.5, 0.004, 3, 0.12, tall ? 0.22 : BARK);
    }
  }
  return { geometry: b.build(), radius: 0, walkRadius: 0, kind: tall ? "tallBush" : "bush" };
}

/** Dry grass / reedgrass standing out of the snow: a tuft of thin bent blades. */
export function buildGrass(seed: number, size: number): TreeVariant {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  b.matter = MATTER.straw;
  b.flex = 1.65;
  const blades = 8 + Math.floor(rand() * 7);
  for (let i = 0; i < blades; i++) {
    const az = rand() * TAU;
    const x = (rand() - 0.5) * 0.35 * size;
    const z = (rand() - 0.5) * 0.35 * size;
    const h = size * (0.35 + rand() * 0.45);
    const lean = 0.1 + rand() * 0.5;
    const w = 0.012 + rand() * 0.012;
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
  b.flex = 0;
  const r = 0.2 + rand() * 0.16;
  const sides = 7;
  const ys = [-0.6, 0.05, 0.3, height];
  const radii = [r * 1.5, r * 1.3, r, r * 0.92];
  limb(
    b,
    rand,
    ys.map((y) => new THREE.Vector3(0, y, 0)),
    radii,
    sides,
    () => barkTone(rand, BARK)
  );
  const tips: number[] = [];
  const rimR = r * 0.9;
  const off = rand() * TAU;
  for (let k = 0; k < sides; k++) {
    const a = off + (k / sides) * TAU;
    tips.push(b.vertex(Math.cos(a) * rimR, height + (rand() < 0.3 ? 0.06 + rand() * 0.14 : 0.02), Math.sin(a) * rimR, mix(0.2, 0.42, rand())));
  }
  const heart = b.vertex(0, height - 0.05, 0, 0.35);
  for (let k = 0; k < sides; k++) b.tri(heart, tips[(k + 1) % sides], tips[k]);
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
    // Siberian Fir (Abies sibirica): narrow dark spires
    buildFir(s(), 11),
    buildFir(s(), 14),
    buildFir(s(), 17.5),
    buildFir(s(), 21),
    // Siberian Spruce (Picea obovata): main canopy & ragged wind-beaten elders
    buildSpruce(s(), 11.5),
    buildSpruce(s(), 14),
    buildSpruce(s(), 16.5),
    buildSpruce(s(), 19.5),
    buildSpruce(s(), 16, { ragged: true }),
    buildSpruce(s(), 21, { ragged: true }),
    // Second-tier shade-grown spruce/fir understory (4.8–8.5 m)
    buildSpruce(s(), 4.8, { sub: true }),
    buildSpruce(s(), 6.6, { sub: true }),
    buildSpruce(s(), 8.4, { sub: true }),
    // Saplings
    buildSpruce(s(), 1.4, { young: true }),
    buildSpruce(s(), 2.2, { young: true }),
    buildSpruce(s(), 3.2, { young: true }),
    // Siberian Cedar (Pinus sibirica)
    buildCedar(s(), 17.5),
    buildCedar(s(), 21.5),
    // Scots Pine (Pinus sylvestris)
    buildPine(s(), 14.5),
    buildPine(s(), 17.5),
    buildPine(s(), 20.5),
    // Siberian Larch (Larix sibirica — winter leafless conifer)
    buildLarch(s(), 14),
    buildLarch(s(), 17.5),
    buildLarch(s(), 21),
    // Birch (single & clonal multi-stem clumps)
    buildBirch(s(), 9.5, 1),
    buildBirch(s(), 12.5, 1),
    buildBirch(s(), 9, 2),
    buildBirch(s(), 12, 3),
    // Aspen (Populus tremula)
    buildAspen(s(), 12),
    buildAspen(s(), 15),
    // Deadwood snags (conifer & birch)
    buildSnag(s(), 8),
    buildSnag(s(), 11.5),
    buildBirchSnag(s(), 6.5),
    // Ground cover, creek thickets, stumps & boulders
    buildMound(s(), 0.9),
    buildMound(s(), 1.5),
    buildBush(s(), 1.1, false),
    buildBush(s(), 1.5, false),
    buildBush(s(), 2.3, true),
    buildBush(s(), 3.3, true),
    buildGrass(s(), 0.8),
    buildGrass(s(), 1.1),
    buildStump(s(), 0.45),
    buildStump(s(), 0.85),
    buildRock(s(), 0.7),
    buildRock(s(), 1.1),
    buildRock(s(), 1.5)
  ];
}
