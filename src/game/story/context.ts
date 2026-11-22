import type * as THREE from "three";
import type { Steering, Walker } from "../actors/player";
import type { Collider } from "../world/collider";
import type { Sight } from "../world/sight";
import type { HeightFn } from "../world/terrain";
import type { World } from "../world/world";

/** What the page hears from the story. */
export type StoryEvent =
  | { type: "sign"; visible: boolean }
  | { type: "caught" }
  | { type: "eaten" }
  | { type: "inside" }
  | { type: "escaped" };

/** Sounds the story asks for: where from (pan, + is right) and how loud (0..1). */
export interface StoryCues {
  cue?(name: "growl" | "stomp" | "creak", pan: number, level: number): void;
}

/** What every part of the story works with. */
export interface Stage {
  world: World;
  height: HeightFn;
  walker: Walker;
  steering: Steering;
  camera: THREE.PerspectiveCamera;
  sight: Sight;
  cues: StoryCues;
  rand: () => number;
}

/** The way the walker faces, which is the way they go: there is no walking sideways. */
export function forward(walker: Walker): [number, number] {
  return [-Math.sin(walker.yaw), -Math.cos(walker.yaw)];
}

/** Where a sound at (x, z) is heard from (+ is right) and how loud it is at this distance. */
export function heard(walker: Walker, x: number, z: number, range: number): [number, number] {
  const p = walker.position;
  const dx = x - p.x;
  const dz = z - p.z;
  const d = Math.hypot(dx, dz) || 1;
  const yaw = walker.yaw;
  return [(dx * Math.cos(yaw) - dz * Math.sin(yaw)) / d, Math.max(0, 1 - d / range) ** 1.3];
}

/**
 * Whether the straight line from a to b passes clear of everything standing there;
 * `room` gives the berth each thing needs (none for 0 or less).
 */
export function lineClear(colliders: Collider[], ax: number, az: number, bx: number, bz: number, room: (c: Collider) => number): boolean {
  const sx = bx - ax;
  const sz = bz - az;
  const len2 = sx * sx + sz * sz;
  if (len2 < 1e-6) return true;
  for (const c of colliders) {
    const r = room(c);
    if (r <= 0) continue;
    const t = ((c.x - ax) * sx + (c.z - az) * sz) / len2;
    if (t <= 0 || t >= 1) continue;
    if (Math.hypot(ax + sx * t - c.x, az + sz * t - c.z) < r) return false;
  }
  return true;
}

/** Nothing standing here: no tree, drift or trunk within `room` metres. */
export function roomy(colliders: Collider[], x: number, z: number, room: number): boolean {
  for (const c of colliders) {
    const reach = Math.max(c.walk, c.r * 0.6, c.footprint ?? 0, c.mound?.reach ?? 0) + room;
    if ((x - c.x) ** 2 + (z - c.z) ** 2 < reach * reach) return false;
  }
  return true;
}
