import type { HeightFn } from "./terrain";
import type { Collider } from "./collider";
import type { World } from "./world";
import { EYE } from "../actors/player";

export interface Start {
  x: number;
  z: number;
  /** Walker yaw: facing (-sin yaw, -cos yaw). */
  yaw: number;
}

/** Spots tried, out to this far from the origin, on rings this far apart. */
const SEARCH = 36;
const SEARCH_STEP = 4;
const HEADINGS = 36;
/** The middle of the view that must be open: nothing standing in it this close. */
const CONE = 0.5;
const CLEAR = 16;
/** Nothing anywhere in the view this close, out to its edges. */
const CLOSE = 8;
const WIDE = 1;
/** Where a few trees should stand, deep in the view but not so deep the snow hides them. */
const FAR_NEAR = 18;
const FAR_FAR = 30;
const FAR_CONE = 0.7;
/** Out to the far side of the first deer's crossing. */
const DEER = 24;
/** How far the snow ahead is looked over for rises and drops. */
const GROUND = 34;

/**
 * Picks where the walk begins: a spot near a centre (the origin on a first visit)
 * and a heading with open, level snow ahead and trees standing off in the distance,
 * never face to face with a trunk or a drift.
 */
export function findStart(world: World, height: HeightFn, cx = 0, cz = 0): Start {
  const colliders: Collider[] = [];
  const reach = SEARCH + FAR_FAR;
  world.collidersIn(cx - reach, cz - reach, cx + reach, cz + reach, colliders);
  let best: Start = { x: cx, z: cz, yaw: 0 };
  let bestScore = -Infinity;

  for (let ring = 0; ring * SEARCH_STEP <= SEARCH; ring++) {
    const r = ring * SEARCH_STEP;
    const spots = ring === 0 ? 1 : Math.round((Math.PI * 2 * r) / SEARCH_STEP);
    for (let s = 0; s < spots; s++) {
      const a = (s / spots) * Math.PI * 2;
      const x = cx + Math.sin(a) * r;
      const z = cz + Math.cos(a) * r;
      if (!roomy(x, z, colliders)) continue;
      const eye = height(x, z) + EYE;
      for (let h = 0; h < HEADINGS; h++) {
        const yaw = (h / HEADINGS) * Math.PI * 2;
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        const score = rate(x, z, eye, fx, fz, colliders, height) - r * 0.01;
        if (score > bestScore) {
          bestScore = score;
          best = { x, z, yaw };
        }
      }
    }
  }
  return best;
}

/** Not standing in a tree or on a drift. */
function roomy(x: number, z: number, colliders: Collider[]): boolean {
  for (const c of colliders) {
    const reach = Math.max(c.r, c.mound?.reach ?? 0) + 2;
    if ((x - c.x) ** 2 + (z - c.z) ** 2 < reach * reach) return false;
  }
  return true;
}

function rate(x: number, z: number, eye: number, fx: number, fz: number, colliders: Collider[], height: HeightFn): number {
  // Nothing in the middle of the view up close; a few trees further out.
  let far = 0;
  let near = 0;
  // A fallen trunk is a row of colliders, but one thing in the way.
  const trunks = new Set<Collider["log"]>();
  for (const c of colliders) {
    const dx = c.x - x;
    const dz = c.z - z;
    const along = dx * fx + dz * fz;
    if (along <= 0) continue;
    const across = Math.abs(dx * fz - dz * fx);
    const size = Math.max(c.r, c.mound?.reach ?? 0);
    if (along < CLEAR && across - size < along * Math.tan(CONE)) return -Infinity;
    if (along < CLOSE && across - size < along * Math.tan(WIDE)) return -Infinity;
    // Straight ahead, where the first deer crosses, the fewer the better.
    if (along < DEER && across - size < along * Math.tan(CONE) * 0.6 && !trunks.has(c.log)) {
      near++;
      if (c.log) trunks.add(c.log);
    }
    if (along >= FAR_NEAR && along < FAR_FAR && across < along * Math.tan(FAR_CONE) && c.r > 0 && !c.log) far++;
  }

  // Level snow ahead: no rise that would fill the view, no drop into a hollow.
  const ground = height(x, z);
  let rise = 0;
  let drop = 0;
  for (const off of [-0.35, 0, 0.35]) {
    const c = Math.cos(off);
    const s = Math.sin(off);
    const rx = fx * c - fz * s;
    const rz = fz * c + fx * s;
    for (let d = 2; d <= GROUND; d += 2) {
      const y = height(x + rx * d, z + rz * d);
      // Rising above a line from the eyes, slightly downhill, hides what lies beyond.
      rise = Math.max(rise, y - (eye - 1.2 - d * 0.02));
      drop = Math.max(drop, ground - y);
    }
  }
  if (rise > 0) return -Infinity;

  // Some trees in the distance (about seven reads as a forest without walling off the view;
  // fewer than four is an empty field).
  const trees = -Math.abs(Math.min(far, 14) - 7) * 0.25 - (far < 4 ? 6 : 0);
  return trees - near * 0.8 - Math.max(0, drop - 1.5) * 0.5;
}

/** The yeti's beginning: spots tried out to this far from the centre, this far apart. */
const DEEP_SEARCH = 44;
const DEEP_STEP = 4;
/** Trees counted out to this far round a spot; this many make it deep forest. */
const DEEP_AROUND = 14;
const DEEP_TREES = 22;
/** Open ground needed straight ahead, to set off without walking into a trunk. */
const DEEP_AHEAD = 7;

/**
 * Picks where the yeti's walk begins: deep in the forest, trees close all round, a spruce
 * just off to one side so its boughs hang in the edge of the view, and a way open ahead.
 */
export function findForestStart(world: World, height: HeightFn, cx: number, cz: number): Start {
  const colliders: Collider[] = [];
  const reach = DEEP_SEARCH + DEEP_AROUND;
  world.collidersIn(cx - reach, cz - reach, cx + reach, cz + reach, colliders);
  const trees = colliders.filter((c) => c.r > 0 && c.walk > 0 && !c.log && !c.mound);
  let best: Start | null = null;
  let bestScore = -Infinity;
  for (let r = 0; r <= DEEP_SEARCH; r += DEEP_STEP) {
    const spots = r === 0 ? 1 : Math.round((Math.PI * 2 * r) / DEEP_STEP);
    for (let s = 0; s < spots; s++) {
      const a = (s / spots) * Math.PI * 2;
      const x = cx + Math.sin(a) * r;
      const z = cz + Math.cos(a) * r;
      let clear = true;
      for (const c of colliders) {
        const room = Math.max(c.walk + 1.1, c.mound ? c.mound.reach + 0.6 : 0, c.footprint ?? 0);
        if ((x - c.x) ** 2 + (z - c.z) ** 2 < room * room) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      let around = 0;
      for (const c of trees) if ((x - c.x) ** 2 + (z - c.z) ** 2 < DEEP_AROUND * DEEP_AROUND) around++;
      const ground = height(x, z);
      for (let h = 0; h < HEADINGS; h++) {
        const yaw = (h / HEADINGS) * Math.PI * 2;
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        let free = DEEP_AHEAD;
        let bough = 0;
        for (const c of colliders) {
          if (c.walk <= 0 && !c.footprint) continue;
          const dx = c.x - x;
          const dz = c.z - z;
          const along = dx * fx + dz * fz;
          const across = Math.abs(dx * fz - dz * fx);
          if (along > 0 && along < free && across < Math.max(c.walk, c.footprint ?? 0) + 0.8) free = along;
          // A spruce a step ahead and to the side: its boughs at the edge of the view.
          if (c.r > 1 && !c.log && along > 1.5 && along < 5 && across > c.walk + 0.9 && across < c.walk + 2.6) bough = 1;
        }
        if (free < DEEP_AHEAD) continue;
        // Not looking up a bank, nor down into a hollow.
        const rise = Math.abs(height(x + fx * 8, z + fz * 8) - ground);
        const score = Math.min(around, DEEP_TREES * 1.5) * 0.3 - (around < DEEP_TREES ? 4 : 0) + bough * 2 - rise * 0.8 - r * 0.02;
        if (score > bestScore) {
          bestScore = score;
          best = { x, z, yaw };
        }
      }
    }
  }
  return best ?? findStart(world, height, cx, cz);
}
