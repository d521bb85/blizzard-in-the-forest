import * as THREE from "three";
import type { Collider } from "../world/collider";

/** The headings a deer or the yeti tries, as offsets from the way it wants to go: straight on first, then wider and wider. */
export const HEADINGS = [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.25, -1.25, 1.65, -1.65, 2.1, -2.1, 2.6, -2.6, Math.PI];

/**
 * Open ground from p along a unit direction, up to max. `room` gives how wide a berth
 * each thing in the way needs (its own radius plus the body going past); none for 0 or less.
 */
export function freeDistance(
  p: THREE.Vector3,
  dx: number,
  dz: number,
  colliders: Collider[],
  max: number,
  room: (c: Collider) => number
): number {
  let free = max;
  for (const c of colliders) {
    const r = room(c);
    if (r <= 0) continue;
    const ox = c.x - p.x;
    const oz = c.z - p.z;
    const along = ox * dx + oz * dz;
    if (along <= 0 || along - r > free) continue;
    const perp2 = ox * ox + oz * oz - along * along;
    if (perp2 >= r * r) continue;
    free = Math.min(free, Math.max(0, along - Math.sqrt(r * r - perp2)));
  }
  return free;
}

/** How pace changes with the ground: slower uphill, a little quicker down. The walker and the yeti share it, so neither gains on a slope. */
export const slopePace = (uphill: number) => THREE.MathUtils.clamp(1 - uphill * 0.7, 0.72, 1.1);
