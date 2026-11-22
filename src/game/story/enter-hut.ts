import * as THREE from "three";
import { smooth, wrap } from "../lib/math";
import type { Hut } from "../props/hut";
import { forward, heard, type Stage } from "./context";
import { DOOR_TIME, INSIDE_HOLD, INSIDE_TIME } from "./tuning";

/**
 * Going into the hut: the door swings half open while the walker carries on in one
 * unbroken glide, slowing from their own pace, through the gap into the room, the dark
 * closing over as they go in.
 */
export class EnterHut {
  /** 0..1: how far the screen has gone black. */
  blackout = 0;
  private t = 0;
  private yaw = 0;
  private pitch = 0;
  private roll = 0;
  /** The way in: a cubic Bezier, its length, and how long the glide takes. */
  private path = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private lengths: number[] = [];
  private length = 1;
  private time = INSIDE_TIME;
  /** Starting pace as a share of the glide's average, so it carries on at the walker's speed. */
  private lead = 0;
  private prev = new THREE.Vector3();

  constructor(
    private stage: Stage,
    private hut: Hut
  ) {}

  reset(): void {
    this.blackout = 0;
    this.t = 0;
  }

  begin(): void {
    const { camera, walker, cues } = this.stage;
    this.t = 0;
    this.blackout = 0;
    this.yaw = camera.rotation.y;
    this.pitch = camera.rotation.x;
    this.roll = camera.rotation.z;
    // The way in: leaving along the way you were going, swinging round onto the line
    // through the door's gap, and on through it into the dark.
    const [p0, p1, p2, p3] = this.path;
    const pace = Math.hypot(walker.velocity.x, walker.velocity.z);
    p0.copy(camera.position);
    this.hut.gap(p2, 0.8);
    this.hut.gap(p3, -0.45);
    const [fx, fz] = forward(walker);
    const dx = pace > 0.3 ? walker.velocity.x / pace : fx;
    const dz = pace > 0.3 ? walker.velocity.z / pace : fz;
    const reach = Math.hypot(p2.x - p0.x, p2.z - p0.z) * 0.45;
    p1.set(p0.x + dx * reach, p0.y + (p2.y - p0.y) * 0.3, p0.z + dz * reach);
    // Never through a wall: the first pull stays out in front of the hut.
    if (this.hut.frontOf(p1.x, p1.z) < 0.6) p1.lerp(p2, 0.6);
    this.lengths.length = 0;
    this.lengths.push(0);
    const q = new THREE.Vector3();
    const last = new THREE.Vector3().copy(p0);
    for (let i = 1; i <= 32; i++) {
      this.bezier(i / 32, q);
      this.lengths.push(this.lengths[i - 1] + q.distanceTo(last));
      last.copy(q);
    }
    this.length = this.lengths[32];
    // Carry on at your own pace, slowing to a stop in the doorway; a fast run in takes less
    // time, so the start never outruns the curve (lead above 3 would overshoot and come back).
    this.time = THREE.MathUtils.clamp((2.6 * this.length) / Math.max(pace, 0.1), 1.5, INSIDE_TIME);
    this.lead = Math.min(2.6, (pace * this.time) / this.length);
    const [pan] = heard(walker, this.hut.position.x, this.hut.position.z, 10);
    cues.cue?.("creak", pan * 0.5, 0.8);
  }

  /** Moves the camera along the way in. True once the dark has held long enough: the scene is over. */
  update(dt: number): boolean {
    const cam = this.stage.camera;
    this.t += dt;
    // Quick to give at first, then easing to a stop half open, well ahead of you.
    this.hut.setDoor(1 - (1 - Math.min(1, this.t / DOOR_TIME)) ** 3);
    // Distance along the way so far: a cubic that starts at your own pace and comes to rest
    // in the doorway (it never doubles back, as the starting pace is capped above).
    const u = Math.min(1, this.t / this.time);
    const along = this.length * (this.lead * (u * u * u - 2 * u * u + u) + (3 * u * u - 2 * u * u * u));
    const prev = this.prev.copy(cam.position);
    this.pointAlong(along, cam.position);
    const turn = smooth(u / 0.75);
    cam.rotation.set(THREE.MathUtils.lerp(this.pitch, -0.02, turn), this.yaw + wrap(this.hut.yaw - this.yaw) * turn, this.roll * (1 - turn));
    if (dt > 0) this.stage.walker.velocity.subVectors(cam.position, prev).divideScalar(dt);
    // The dark fills the view as the gap comes up close, late enough to see into the room first.
    this.blackout = smooth((u - 0.55) / 0.45);
    return this.t >= this.time + INSIDE_HOLD;
  }

  /** The point a distance along the way in. */
  private pointAlong(d: number, out: THREE.Vector3): THREE.Vector3 {
    const n = this.lengths.length - 1;
    let i = 1;
    while (i < n && this.lengths[i] < d) i++;
    const l0 = this.lengths[i - 1];
    const l1 = this.lengths[i];
    const t = (i - 1 + (l1 > l0 ? THREE.MathUtils.clamp((d - l0) / (l1 - l0), 0, 1) : 0)) / n;
    return this.bezier(t, out);
  }

  private bezier(t: number, out: THREE.Vector3): THREE.Vector3 {
    const [a, b, c, d] = this.path;
    const m = 1 - t;
    return out
      .copy(a)
      .multiplyScalar(m * m * m)
      .addScaledVector(b, 3 * m * m * t)
      .addScaledVector(c, 3 * m * t * t)
      .addScaledVector(d, t * t * t);
  }
}
