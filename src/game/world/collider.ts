import type { Ridge } from "./logs";

/** Something standing on the snow that can be in the way: a tree, a drift, a boulder, a fallen trunk, a wall. */
export interface Collider {
  x: number;
  z: number;
  /** Radius at eye height, out to the branch skirts; what deer keep clear of. */
  r: number;
  /** What the walker bumps into; 0 for a drift the walker climbs over. */
  walk: number;
  /** A drift the walker can climb: base height at its centre, height, and footprint radius. */
  mound?: { y: number; h: number; reach: number };
  /** Any drift, climbable or not, or a boulder: how far it spreads over the ground. */
  footprint?: number;
  /** Part of a fallen trunk (the walker steps over it) or its root plate (a wall). */
  log?: Ridge;
}

/**
 * Tree colliders are sized for a person's eyes, out to the spruce skirts. A deer
 * can't walk through a trunk and the dense wood around it (the core), and would
 * rather go round the skirt than push under its branches.
 */
export const coreRadius = (c: Collider) => c.r * 0.3 + 0.35;
