import * as THREE from "three";
import { smoothstep } from "../lib/noise";
import { terrainNormal, type HeightFn } from "./terrain";
import { BARK, GeoBuilder, SNOW, TAU, mix, tube } from "./trees";
import { coreRadius, type Collider } from "./collider";

/** Metadata returned when a fallen trunk is placed, for coupling stumps, snags and gap saplings. */
export interface PlacedLog {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  dx: number;
  dz: number;
  length: number;
  r0: number;
  rooted: boolean;
}

/** The snowed-over top of a fallen trunk, for walking over it. World coordinates. */
export interface Ridge {
  /** The trunk's ends on the ground plane, and the snow's height above each. */
  ax: number;
  az: number;
  bx: number;
  bz: number;
  ya: number;
  yb: number;
  /** How far to either side the drift rises off the snowfield. */
  reach: number;
  /** How far past each end the trunk can still be stepped on: a little past a snapped end, not at all into a root plate. */
  overA: number;
  overB: number;
}

/** Height of the snow over a fallen trunk at a point, or -Infinity off it. */
export function ridgeHeight(r: Ridge, x: number, z: number, ground: number): number {
  const ex = r.bx - r.ax;
  const ez = r.bz - r.az;
  const len = Math.hypot(ex, ez);
  const s = ((x - r.ax) * ex + (z - r.az) * ez) / (len * len);
  // Past an end, the trunk drops away within its overhang.
  const over = s < 0 ? r.overA : r.overB;
  const past = s < 0 ? -s * len : s > 1 ? (s - 1) * len : 0;
  if (past > 0 && past >= over) return -Infinity;
  const q = Math.abs((x - r.ax) * ez - (z - r.az) * ex) / len / r.reach;
  if (q >= 1) return -Infinity;
  const top = r.ya + (r.yb - r.ya) * Math.min(1, Math.max(0, s));
  if (top <= ground) return -Infinity;
  // Flat along the trunk, then down the drifts on either side.
  const end = past > 0 ? 1 - smoothstep(0, over, past) : 1;
  return ground + (top - ground) * (1 - smoothstep(0.3, 1, q)) * end;
}

/** Smooth random values along a trunk, about one bump per `spacing` metres, 0..1. */
function lumps(rand: () => number, length: number, spacing: number): (t: number) => number {
  const knots = Array.from({ length: Math.ceil(length / spacing) + 2 }, rand);
  return (t) => {
    const f = Math.min(1, Math.max(0, t)) * (knots.length - 2);
    const i = Math.floor(f);
    const u = f - i;
    return mix(knots[i], knots[i + 1], u * u * (3 - 2 * u));
  };
}

function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax;
  const ez = bz - az;
  const t = Math.min(1, Math.max(0, ((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez)));
  return Math.hypot(px - ax - ex * t, pz - az - ez * t);
}

/** Cross-section of the snow cap over a trunk, as shares of its angle from the top. */
const CAP = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1];
/** Metres between the trunk's bark rings, and between snow cross-sections. */
const RING_STEP = 0.6;
const SNOW_STEP = 0.45;
/** How steep the ground under a trunk may be, and how far it may bridge a hollow. */
const MAX_TILT = 0.3;
const MAX_GAP = 0.45;
/**
 * Keeps whole trunks inside their chunk, clear of what stands in the next one
 * (placement only sees its own chunk): the widest drift's footprint and a trunk's radius.
 */
const EDGE = 2.8;

/**
 * Fallen spruce trunks, lying where they came down: on the ground, sunk into the
 * snow, drifted over along their length, some with the root plate torn up at the
 * thick end. Built per chunk, in chunk-local coordinates, as two meshes: bark
 * (tree material) and the snow on it (snow material, so it meets the snowfield
 * without a seam).
 */
export class LogBuilder {
  readonly bark = new GeoBuilder();
  readonly snow = new GeoBuilder();
  /** Per snow vertex: how far its shading turns to the snowfield's, so the drifts' edges disappear into it. */
  private blend: number[] = [];

  /** `clear`: no trunk within this far of the world origin, where every walk begins. */
  constructor(
    private height: HeightFn,
    private ox: number,
    private oz: number,
    private size: number,
    private clear: number
  ) {}

  get empty(): boolean {
    return this.bark.indices.length === 0;
  }

  /** The snow mesh, its drifts shaded like the snowfield where they run into it. */
  buildSnow(): THREE.BufferGeometry {
    const geo = this.snow.build();
    const normals = geo.attributes.normal as THREE.BufferAttribute;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const own = new THREE.Vector3();
    const field = new THREE.Vector3();
    this.blend.forEach((w, i) => {
      if (w <= 0) return;
      own.fromBufferAttribute(normals, i);
      terrainNormal(this.height, pos.getX(i) + this.ox, pos.getZ(i) + this.oz, field);
      own.lerp(field, w).normalize();
      normals.setXYZ(i, own.x, own.y, own.z);
    });
    return geo;
  }

  /**
   * Tries to lay a trunk centred near (x, z), moved as needed to keep inside the
   * chunk. Gives up, adding nothing, where it would cross a tree, a drift or
   * another trunk, or lie on ground too steep or too hollow for it. Adds its
   * colliders on success and returns its placement info.
   */
  add(rand: () => number, x: number, z: number, colliders: Collider[], preferredYaw?: number): PlacedLog | null {
    const yaw = preferredYaw !== undefined ? preferredYaw : rand() * TAU;
    const length = 4.8 + rand() * 5.2;
    const r0 = 0.19 + rand() * 0.14;
    const r1 = r0 * (0.45 + rand() * 0.2);
    const plate = rand() < 0.45 ? 0.75 + r0 * 1.6 + rand() * 0.3 : 0;
    const dx = Math.cos(yaw);
    const dz = Math.sin(yaw);
    // Slid wholly inside the chunk, with room for the root plate at the thick end.
    const fit = (centre: number, along: number, origin: number) => {
      const a = centre - (along * length) / 2;
      const b = centre + (along * length) / 2;
      const lo = Math.max(origin + EDGE + plate - a, origin + EDGE - b);
      const hi = Math.min(origin + this.size - EDGE - plate - a, origin + this.size - EDGE - b);
      return lo > hi ? NaN : centre + Math.min(hi, Math.max(lo, 0));
    };
    x = fit(x, dx, this.ox);
    z = fit(z, dz, this.oz);
    if (Number.isNaN(x) || Number.isNaN(z)) return null;
    const ax = x - (dx * length) / 2;
    const az = z - (dz * length) / 2;
    const bx = x + (dx * length) / 2;
    const bz = z + (dz * length) / 2;
    // Lateral, on the ground plane.
    const nx = -dz;
    const nz = dx;

    if (segmentDistance(0, 0, ax, az, bx, bz) < this.clear) return null;
    // Clear of trunks and drifts, though it may lie under a spruce's branches.
    for (const c of colliders) {
      // Trees: only their wood, at most as wide as a big spruce's trunk core, not its branches.
      const clear = c.log
        ? c.r + r0 + 0.6
        : c.footprint !== undefined
          ? c.footprint + r0 + 0.2
          : Math.min(0.9, coreRadius(c)) + r0 + 0.15;
      if (segmentDistance(c.x, c.z, ax, az, bx, bz) < clear) return null;
      if (plate > 0 && Math.hypot(c.x - ax, c.z - az) < clear + plate) return null;
    }

    // Lie on the ground: the line through the ends, raised until nothing pokes through, then sunk into the snow.
    const samples = Math.ceil(length / 0.5) + 1;
    const ground: number[] = [];
    for (let i = 0; i < samples; i++) {
      const t = i / (samples - 1);
      ground.push(this.height(mix(ax, bx, t), mix(az, bz, t)));
    }
    const ga = ground[0];
    const gb = ground[samples - 1];
    if (Math.abs(gb - ga) / length > MAX_TILT) return null;
    let lift = 0;
    for (let i = 0; i < samples; i++) lift = Math.max(lift, ground[i] - mix(ga, gb, i / (samples - 1)));
    const sink = r0 * (0.3 + rand() * 0.3) + 0.05;
    const bottom = (t: number) => mix(ga, gb, t) + lift - sink;
    let gap = 0;
    for (let i = 0; i < samples; i++) gap = Math.max(gap, bottom(i / (samples - 1)) - ground[i]);
    if (gap > MAX_GAP) return null;

    const radius = (t: number) => mix(r0, r1, t);
    const centreY = (t: number) => bottom(t) + radius(t);
    const a3 = new THREE.Vector3(ax, centreY(0), az);
    const b3 = new THREE.Vector3(bx, centreY(1), bz);
    const d = new THREE.Vector3().subVectors(b3, a3).normalize();
    const n = new THREE.Vector3(nx, 0, nz);
    const u = new THREE.Vector3().crossVectors(n, d).normalize();
    const centre = (t: number, out: THREE.Vector3) => out.lerpVectors(a3, b3, t);

    this.buildBark(rand, centre, radius, d, n, u, length, plate > 0);
    if (plate > 0) this.buildPlate(rand, ax, az, ga, plate, d, n, r0);

    // Snow: a cap along the top and a drift banked against each side, thicker
    // and wider on the lee side. Both rise and fall along the trunk, so the dark
    // bark shows between them in places and is buried in others.
    const thick = lumps(rand, length, 1.3);
    const spread = Math.min(1.25, 0.85 + rand() * 0.5);
    const capWidth = lumps(rand, length, 1.1);
    const bankL = lumps(rand, length, 1.4);
    const bankR = lumps(rand, length, 1.4);
    const wideL = lumps(rand, length, 1.7);
    const wideR = lumps(rand, length, 1.7);
    const lee = rand() < 0.5 ? -1 : 1;
    const capT = 0.05 + rand() * 0.07;
    const e0 = plate > 0 ? 0.1 : 0.3 + rand() * 0.35;
    const e1 = 0.3 + rand() * 0.4;
    let reach = 0;
    const ns = Math.max(2, Math.ceil((length - e0 - e1) / SNOW_STEP) + 1);
    // Each end closes with one more row: the cap thins onto the bark, the drifts slope into the snowfield.
    const rows: { t: number; close: number }[] = [{ t: (e0 - 0.35) / length, close: -1 }];
    for (let i = 0; i < ns; i++) rows.push({ t: mix(e0, length - e1, i / (ns - 1)) / length, close: 0 });
    rows.push({ t: (length - e1 + 0.35) / length, close: 1 });

    const c = new THREE.Vector3();
    const radial = new THREE.Vector3();
    const p = new THREE.Vector3();
    const snow = this.snow;
    const at = (v: THREE.Vector3, blend: number) => {
      this.blend.push(blend);
      snow.vertex(v.x - this.ox, v.y, v.z - this.oz, SNOW);
    };
    const onBark = (theta: number, r: number) => {
      radial.copy(n).multiplyScalar(Math.sin(theta)).addScaledVector(u, Math.cos(theta));
      return p.copy(c).addScaledVector(radial, r);
    };
    let prev = -1;
    for (const { t, close } of rows) {
      const first = snow.positions.length / 3;
      // The cap's last row sits a little in from the drifts', on the bark itself.
      const tCap = close === 0 ? t : t - (close * 0.12) / length;
      const tc = Math.min(1, Math.max(0, t));
      const tcc = Math.min(1, Math.max(0, tCap));
      // Unclamped: the closing rows reach past the ends.
      centre(t, c);

      // Drifts, outer edge to trunk on the left, then trunk to outer edge on the right.
      for (const side of [-1, 1]) {
        const r = radius(tc);
        const bank = side < 0 ? bankL(tc) : bankR(tc);
        // Height of the bank against the trunk, as a share of the radius above its centre.
        const k = mix(-0.55, 0.45, bank) + (side === lee ? 0.15 : 0);
        const phi = Math.acos(Math.min(0.9, Math.max(-0.9, k)));
        const w = (side === lee ? 0.45 + r0 * 2.2 : 0.25 + r0 * 1.2) * (0.7 + 0.6 * (side < 0 ? wideL(tc) : wideR(tc)));
        if (close === 0) reach = Math.max(reach, r * Math.sin(phi) + w);
        const inner = onBark(side * phi, r * 0.96).clone();
        const qs = side < 0 ? [1, 0.6, 0.25, 0] : [0, 0.25, 0.6, 1];
        for (const q of qs) {
          if (q === 0) p.copy(inner);
          else {
            const off = r * Math.sin(phi) + w * q;
            p.set(c.x + nx * side * off, 0, c.z + nz * side * off);
            const g = this.height(p.x, p.z);
            p.y = q >= 1 ? g - 0.06 : Math.max(g + 0.03, g + (inner.y - g) * (1 - smoothstep(0, 1, q)));
          }
          if (close !== 0) {
            // Ends: pulled in and down to the snowfield.
            p.set(c.x + (p.x - c.x) * 0.45, 0, c.z + (p.z - c.z) * 0.45);
            p.y = this.height(p.x, p.z) - 0.05;
          }
          at(p, close !== 0 ? 1 : q);
        }
      }

      // The cap over the top, thinning to nothing at its edges and at the ends.
      centre(tcc, c);
      const r = radius(tcc);
      const tau = close === 0 ? capT * (0.4 + thick(tcc) * 1.2) : 0;
      const half = (0.75 + capWidth(tcc) * 0.5) * spread;
      for (const f of CAP) {
        const s = f / CAP[CAP.length - 1];
        onBark(s * half, r + 0.012 + tau * (1 - s * s));
        p.y = Math.max(p.y, this.height(p.x, p.z) + 0.03);
        at(p, 0);
      }

      if (prev >= 0) {
        // Left drift 0-3, right drift 4-7, cap 8-14; no faces across them.
        const strips = [[0, 3], [4, 7], [8, 8 + CAP.length - 1]];
        for (const [from, to] of strips) {
          for (let k = from; k < to; k++) {
            snow.tri(prev + k, prev + k + 1, first + k);
            snow.tri(prev + k + 1, first + k + 1, first + k);
          }
        }
      }
      prev = first;
    }

    const ridge: Ridge = {
      ax,
      az,
      bx,
      bz,
      ya: centreY(0) + r0 + capT,
      yb: centreY(1) + r1 + capT,
      reach: Math.max(r0 + 0.3, reach * 0.75),
      overA: plate > 0 ? 0 : r0 + 0.15,
      overB: r1 + 0.15
    };
    // A row of small circles along the trunk: deer walk round it, the walker steps over.
    const links = Math.ceil(length / 0.9) + 1;
    for (let i = 0; i < links; i++) {
      const t = i / (links - 1);
      colliders.push({ x: mix(ax, bx, t), z: mix(az, bz, t), r: radius(t) + 0.3, walk: 0, log: ridge });
    }
    // The root plate is a wall, as wide as it is.
    if (plate > 0) {
      for (const k of [-0.5, 0, 0.5]) {
        colliders.push({ x: ax + nx * plate * k, z: az + nz * plate * k, r: plate * 0.55, walk: plate * 0.5, log: ridge });
      }
    }
    return { ax, az, bx, bz, dx, dz, length, r0, rooted: plate > 0 };
  }

  /** The trunk itself: a tapering, slightly lumpy tube, broken at the thick end unless roots tore up. */
  private buildBark(
    rand: () => number,
    centre: (t: number, out: THREE.Vector3) => THREE.Vector3,
    radius: (t: number) => number,
    d: THREE.Vector3,
    n: THREE.Vector3,
    u: THREE.Vector3,
    length: number,
    rooted: boolean
  ): void {
    const b = this.bark;
    const sides = 7;
    const rings = Math.max(2, Math.ceil(length / RING_STEP) + 1);
    const c = new THREE.Vector3();
    const radial = new THREE.Vector3();
    const offset = rand() * TAU;
    let prev: number[] = [];
    let first: number[] = [];
    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1);
      centre(t, c);
      const r = radius(t);
      const ring: number[] = [];
      for (let k = 0; k < sides; k++) {
        const a = offset + (k / sides) * TAU;
        radial.copy(n).multiplyScalar(Math.cos(a)).addScaledVector(u, Math.sin(a));
        const up = radial.dot(u);
        const rr = r * (0.9 + rand() * 0.2);
        // Splintered where it snapped: the ring's vertices pulled back by different amounts.
        const splinter = i === 0 && !rooted ? -(0.05 + rand() * 0.3) : 0;
        const snowy = up > 0.3 && rand() < 0.75;
        const g = snowy ? mix(0.6, SNOW, rand()) : BARK * (0.7 + rand() * 0.6);
        ring.push(
          b.vertex(
            c.x + radial.x * rr + d.x * splinter - this.ox,
            c.y + radial.y * rr + d.y * splinter,
            c.z + radial.z * rr + d.z * splinter - this.oz,
            g
          )
        );
      }
      if (i === 0) first = ring;
      else {
        for (let k = 0; k < sides; k++) {
          const j = (k + 1) % sides;
          b.tri(prev[k], ring[k], ring[j]);
          b.tri(prev[k], ring[j], prev[j]);
        }
      }
      prev = ring;
    }
    // End faces: pale broken wood at a snapped end, dark at the thin top.
    // Wound to face out along the trunk at the top end and back along it at the thick end.
    const cap = (ring: number[], t: number, gray: number, inset: number) => {
      centre(t, c);
      const mid = b.vertex(c.x + d.x * inset - this.ox, c.y + d.y * inset, c.z + d.z * inset - this.oz, gray);
      for (let k = 0; k < sides; k++) {
        const j = (k + 1) % sides;
        if (t > 0) b.tri(mid, ring[j], ring[k]);
        else b.tri(mid, ring[k], ring[j]);
      }
    };
    if (!rooted) cap(first, 0, 0.42, -0.12);
    cap(prev, 1, 0.28, 0.02);

    // Stubs of dead branches, pointing up and out, swept towards the top.
    const stubs = 3 + Math.floor(rand() * 5);
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    for (let s = 0; s < stubs; s++) {
      const t = 0.25 + rand() * 0.7;
      centre(t, from);
      const a = (rand() - 0.5) * Math.PI * 1.4;
      radial.copy(n).multiplyScalar(Math.sin(a)).addScaledVector(u, Math.cos(a));
      const len = (0.3 + rand() * 0.7) * (1.1 - t * 0.5);
      to.copy(from).addScaledVector(radial, len + radius(t)).addScaledVector(d, len * 0.5);
      from.addScaledVector(radial, radius(t) * 0.5);
      from.x -= this.ox;
      from.z -= this.oz;
      to.x -= this.ox;
      to.z -= this.oz;
      tube(b, rand, from, to, 0.03 + rand() * 0.03, 0.008, 4, 0.7);
    }
  }

  /** Roots and frozen earth torn up with the tree, standing on edge at the thick end. */
  private buildPlate(
    rand: () => number,
    ax: number,
    az: number,
    ground: number,
    size: number,
    d: THREE.Vector3,
    n: THREE.Vector3,
    r0: number
  ): void {
    const b = this.bark;
    const cx = ax - this.ox;
    const cz = az - this.oz;
    const cy = ground + size * 0.25;
    // Flat on the side the trunk comes out of, bulging with roots behind.
    const front = 0.05;
    const back = -(0.2 + rand() * 0.15);
    const dh = new THREE.Vector3(d.x, 0, d.z).normalize();
    const rim = 16;
    const fr: number[] = [];
    const br: number[] = [];
    const tips: THREE.Vector3[] = [];
    for (let k = 0; k < rim; k++) {
      const a = (k / rim) * TAU + (rand() - 0.5) * 0.25;
      // Ragged: clods and root ends sticking out between hollows.
      const r = size * (0.6 + rand() * 0.35) * (k % 2 === 0 ? 1.15 : 0.9);
      const lx = Math.cos(a) * r;
      const ly = Math.sin(a) * r * 0.85;
      const x = cx + n.x * lx;
      const z = cz + n.z * lx;
      const y = cy + ly;
      // Snow lies along the upper edge; earth and roots everywhere else.
      const top = Math.sin(a) > 0.3;
      const g = top && rand() < 0.8 ? mix(0.65, SNOW, rand()) : 0.07 + rand() * 0.1;
      const jag = (rand() - 0.5) * 0.15;
      fr.push(b.vertex(x + dh.x * (front + jag), y, z + dh.z * (front + jag), g));
      br.push(b.vertex(x + dh.x * back * 0.6, y, z + dh.z * back * 0.6, top ? g * 0.8 : 0.06 + rand() * 0.08));
      tips.push(new THREE.Vector3(x, y, z));
    }
    const mf = b.vertex(cx + dh.x * front, cy, cz + dh.z * front, 0.12);
    const mb = b.vertex(cx + dh.x * back, cy - size * 0.1, cz + dh.z * back, 0.08);
    for (let k = 0; k < rim; k++) {
      const j = (k + 1) % rim;
      b.tri(mf, fr[k], fr[j]);
      b.tri(mb, br[j], br[k]);
      b.tri(fr[k], br[k], br[j]);
      b.tri(fr[k], br[j], fr[j]);
    }
    // Torn roots sticking out of the rim and the back.
    const roots = 9 + Math.floor(rand() * 6);
    const to = new THREE.Vector3();
    for (let i = 0; i < roots; i++) {
      const from = tips[Math.floor(rand() * rim)].clone();
      if (from.y < ground - 0.1) continue;
      to.copy(from)
        .sub(new THREE.Vector3(cx, cy, cz))
        .normalize()
        .multiplyScalar(0.3 + rand() * 0.6)
        .addScaledVector(dh, -(0.1 + rand() * 0.4))
        .add(from);
      tube(b, rand, from, to, 0.035 + r0 * 0.12, 0.006, 4, 0.2);
    }
  }
}
