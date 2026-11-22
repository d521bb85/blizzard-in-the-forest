import * as THREE from "three";
import { smooth, wrap } from "../lib/math";
import type { Yeti } from "../actors/yeti";
import { heard, type Stage } from "./context";
import { DARK_HOLD, HELD_ABOVE, HELD_AHEAD, HELD_REACH, LIFT_TIME, LOWERED, LOWER_LEAD, LOWER_TIME, MOUTH_AHEAD } from "./tuning";

/** When, in seconds from being seized, it starts bringing the walker down, and when the scene is over. */
const LOWER_FROM = LIFT_TIME - LOWER_LEAD;
const OVER_AT = LOWER_FROM + LOWER_TIME + DARK_HOLD;

/**
 * Caught. In its hands, in one movement: turned round to face it (whichever way the walker
 * was looking), pulled in, swung up over its head and straight down again to its open
 * jaws, without a pause at the top; the dark closes over as they come up close.
 */
export class Caught {
  /** 0..1: how far the screen has gone black. */
  blackout = 0;
  private t = 0;
  private yaw = 0;
  private pitch = 0;
  private roll = 0;
  /** Where the eyes were, and where the walker stood, when it got hold of them. */
  private from = new THREE.Vector3();
  private at = new THREE.Vector3();
  private roared = false;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmp3 = new THREE.Vector3();

  constructor(
    private stage: Stage,
    private yeti: Yeti
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
    this.from.copy(camera.position);
    this.at.copy(walker.position);
    this.roared = false;
    this.yeti.seize();
    const [pan] = heard(walker, this.yeti.position.x, this.yeti.position.z, 10);
    cues.cue?.("growl", pan * 0.5, 0.8);
  }

  /** Moves the camera through the yeti's hands. True once the dark has held long enough: the scene is over. */
  update(dt: number): boolean {
    const { camera: cam, world, height, walker, cues } = this.stage;
    const y = this.yeti;
    this.t += dt;
    const u = Math.min(1, this.t / LIFT_TIME);
    // How far down to its mouth, 0 (on the way up) to 1 (at its jaws).
    const down = smooth((this.t - LOWER_FROM) / LOWER_TIME);
    y.lift = smooth((u - 0.08) / 0.92) * (1 - LOWERED * down);
    y.gape = smooth(down / 0.6);
    y.update(dt, this.at, world, height);
    y.stomp = 0;
    // One roar, as it swings them over the top and starts down.
    if (!this.roared && down > 0) {
      this.roared = true;
      cues.cue?.("growl", 0, 1);
    }

    // Where the walker is held: just over its hands, a little out in front of them, swaying with its breath.
    const prev = this.tmp2.copy(cam.position);
    const hold = y.grip(this.tmp);
    // Out at arm's length to begin with, clear of the fur on its arms, closer in once up high.
    const ahead = HELD_AHEAD + HELD_REACH * (1 - y.lift);
    hold.x += Math.sin(y.heading) * ahead;
    hold.z += Math.cos(y.heading) * ahead;
    hold.y += HELD_ABOVE + Math.sin(this.t * 1.7) * 0.025 * y.lift;
    cam.position.lerpVectors(this.from, hold, smooth(u / 0.4));
    // Then down from up there to just in front of its open mouth.
    const mouth = y.mouth(this.tmp3);
    if (down > 0) {
      cam.position.lerp(
        this.tmp.set(mouth.x + Math.sin(y.heading) * MOUTH_AHEAD, mouth.y + 0.04, mouth.z + Math.cos(y.heading) * MOUTH_AHEAD),
        down
      );
    }
    if (dt > 0) walker.velocity.subVectors(cam.position, prev).divideScalar(dt);

    // Swung round onto its face as they are pulled in, kept on it all the way up, and on its mouth coming down.
    const face = y.face(this.tmp2).lerp(mouth, down);
    const dx = face.x - cam.position.x;
    const dy = face.y - cam.position.y;
    const dz = face.z - cam.position.z;
    const yawTo = Math.atan2(-dx, -dz);
    const pitchTo = Math.atan2(dy, Math.hypot(dx, dz));
    const turn = smooth(u / 0.5);
    cam.rotation.set(
      THREE.MathUtils.lerp(this.pitch, pitchTo, turn),
      this.yaw + wrap(yawTo - this.yaw) * turn,
      this.roll * (1 - turn) + Math.sin(this.t * 1.3) * 0.03 * y.lift
    );

    // The dark fills the view as the jaws come up close, late enough to see into them first.
    this.blackout = smooth((down - 0.45) / 0.55);
    return this.t >= OVER_AT;
  }
}
