import { wrap } from "../lib/math";
import type { Steering, Walker } from "../actors/player";
import { BEND_ACCEPTED, COURSE_BAND, COURSE_FOLLOW, MOVING, SETTLE_DIST, SETTLE_SPREAD, SETTLE_TIME, TURN, TURN_STILL } from "./tuning";

/**
 * Which way the walker is going, and when that changes.
 *
 * The way is a heading that follows the walker while they keep near it (wobbling, weaving
 * round a tree, drifting in a slow curve) and stays put once they swing off it. A change
 * of direction is counted when they have swung TURN or more off it and the new heading
 * has settled: held for a few metres and a moment, with the turning done. Standing and
 * looking about changes nothing, but walking off the way one has looked is a turn.
 */
export class Course {
  /** Whether the walker is walking a settled heading right now: "ahead" is where they will go. */
  settled = false;
  private known = false;
  private yaw = 0;
  /** The heading held lately, and for how many metres and seconds. */
  private heldYaw = 0;
  private heldDist = 0;
  private heldTime = 0;

  reset(): void {
    this.known = false;
    this.settled = false;
    this.heldDist = 0;
    this.heldTime = 0;
  }

  /** Call every frame. True on the frame a change of direction is complete. */
  update(dt: number, walker: Walker, steering: Steering): boolean {
    const pace = Math.hypot(walker.velocity.x, walker.velocity.z);
    this.settled = false;
    if (!steering.walking || pace < MOVING) return false;
    const step = pace * dt;
    if (!this.known) {
      this.known = true;
      this.yaw = this.heldYaw = walker.yaw;
      this.heldDist = this.heldTime = 0;
      return false;
    }
    if (Math.abs(wrap(walker.yaw - this.heldYaw)) > SETTLE_SPREAD) {
      this.heldYaw = walker.yaw;
      this.heldDist = 0;
      this.heldTime = 0;
    } else {
      this.heldDist += step;
      this.heldTime += dt;
    }
    this.settled = this.heldDist >= SETTLE_DIST && this.heldTime >= SETTLE_TIME && Math.abs(walker.turn) <= TURN_STILL;

    const off = wrap(walker.yaw - this.yaw);
    if (Math.abs(off) <= COURSE_BAND) {
      this.yaw = wrap(this.yaw + off * (1 - Math.exp(-step / COURSE_FOLLOW)));
      return false;
    }
    // Off the way: it stays where it was until the new heading has settled.
    if (!this.settled) return false;
    const turned = Math.abs(off) >= TURN;
    if (!turned && this.heldDist < BEND_ACCEPTED) return false;
    this.yaw = walker.yaw;
    return turned;
  }
}
