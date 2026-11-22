import * as THREE from "three";
import { wrap } from "../lib/math";
import { wave1 } from "../lib/noise";
import { ridgeHeight } from "../world/logs";
import { heightGradient, type HeightFn } from "../world/terrain";
import type { Collider } from "../world/collider";
import type { World } from "../world/world";
import { slopePace } from "./steer";

/** The eyes are this far above the snow. */
export const EYE = 1.68;
const DEAD_ZONE = 0.2;
const LOOK_YAW = 1.3; // rad/s, turning the head while standing
const LOOK_PITCH = 0.7;
const PITCH_MIN = -0.5;
const PITCH_MAX = 0.45;
const WALK = 0.9;
/** A flat-out run, m/s: what the deer, the yeti and the story are paced against. */
export const RUN = 6.2;
/** Turned to look at something (focusOn), the head swings round this quickly: most of the way in about half a second. */
const FOCUS_RATE = 5.5;
/**
 * And the eyes close in on it: the view narrows to this share of its field (a little over
 * a third nearer, as it looks), easing in and back out at FOCUS_ZOOM_RATE.
 */
const FOCUS_ZOOM = 0.72;
const FOCUS_ZOOM_RATE = 3;
/** The furthest the walker moves between checks for things in the way. */
const MAX_STEP = 0.13;

/** Whose eyes the walk is seen through, and how they get about. */
export interface Body {
  /** Eyes this far above the snow. */
  eye: number;
  /** What bumps into trees. */
  radius: number;
  /** The slowest walk and a flat-out run, m/s. */
  walk: number;
  run: number;
  /** Turning flat out, rad/s. */
  turn: number;
  /** How far the view rocks and sways with each step, and how quickly the steps come, against a person's. */
  sway: number;
  cadence: number;
  /** How pace follows the pointer's offset: offset to this power (above 1, the top speeds want the pointer near the edge). */
  urge: number;
}

/** A person in winter boots. */
export const PERSON: Body = { eye: EYE, radius: 0.32, walk: WALK, run: RUN, turn: 1.45, sway: 1, cadence: 1, urge: 1.5 };
/**
 * The yeti: eyes well above a man's head, a bulk that needs a wider berth, slow to turn
 * and long in the stride, each footfall rocking the view. It ambles; the story lets it
 * charge when it has something to run after (Walker.pace), its pace rising evenly with the
 * pointer's offset.
 */
export const YETI_BODY: Body = { eye: 2.32, radius: 0.45, walk: 0.6, run: 2.3, turn: 1.2, sway: 2.1, cadence: 0.62, urge: 1 };

/**
 * Pointer steering. A click (or tap, or Space) toggles walking.
 *
 * Walking: the pointer's offset from screen centre is a direction on a circle
 * around the walker. Up walks ahead, sideways turns, down turns around; the
 * further from centre, the faster.
 * Standing: the same offset only turns the head (left/right, up/down).
 * Inside the central dead zone nothing moves in either mode.
 */
export class Steering {
  x = 0;
  y = 0;
  walking = false;
  /** While locked (a scene playing out, an end screen up), clicks and Space don't toggle walking. */
  locked = false;
  /** Called whenever walking is switched on or off. */
  onWalkingChange: ((walking: boolean) => void) | null = null;
  private active = false;
  private down: { x: number; y: number; t: number } | null = null;

  constructor(target: HTMLElement) {
    const set = (cx: number, cy: number) => {
      const r = Math.min(window.innerWidth, window.innerHeight) * 0.5;
      this.x = (cx - window.innerWidth / 2) / r;
      this.y = (cy - window.innerHeight / 2) / r;
      this.active = true;
    };
    const stop = () => {
      this.active = false;
    };
    // Only the left button of a mouse, or the first finger, steers and toggles.
    const ignored = (e: PointerEvent) => !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0);
    target.addEventListener("pointermove", (e) => {
      if (e.isPrimary && (e.pointerType === "mouse" || e.buttons > 0)) set(e.clientX, e.clientY);
    });
    target.addEventListener("pointerdown", (e) => {
      if (ignored(e)) return;
      set(e.clientX, e.clientY);
      this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    target.addEventListener("pointerup", (e) => {
      if (ignored(e)) return;
      // A short press without dragging is a click or tap: toggle walking.
      const d = this.down;
      this.down = null;
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 10 && performance.now() - d.t < 350) {
        this.toggle();
      }
      if (e.pointerType !== "mouse") stop();
    });
    target.addEventListener("pointercancel", () => {
      this.down = null;
      stop();
    });
    // No browser menu over the scene, and no walking on behind it.
    target.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.down = null;
      stop();
    });
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !e.repeat && !this.locked) {
        e.preventDefault();
        this.toggle();
      }
    });
    // Leaving the scene stops steering: onto the name and links (so nothing jerks
    // while you read or click) or out of the window altogether.
    target.addEventListener("pointerleave", stop);
    document.documentElement.addEventListener("mouseleave", stop);
    window.addEventListener("blur", stop);
  }

  toggle(): void {
    if (this.locked) return;
    this.setWalking(!this.walking);
  }

  setWalking(walking: boolean): void {
    if (walking === this.walking) return;
    this.walking = walking;
    this.onWalkingChange?.(walking);
  }

  /** Returns [magnitude 0..1, angle relative to forward in radians, + is right]. */
  read(): [number, number] {
    if (!this.active) return [0, 0];
    const raw = Math.hypot(this.x, this.y);
    const t = Math.min(1, Math.max(0, (raw - DEAD_ZONE) / (0.92 - DEAD_ZONE)));
    if (t <= 0) return [0, 0];
    // Ease out of the dead zone so starting to move is gentle.
    const mag = t * t * (3 - 2 * t) * 0.6 + t * 0.4;
    return [mag, Math.atan2(this.x, -this.y)];
  }
}

export class Walker {
  /** Whose body this is. Change it only with place() after. */
  body: Body = PERSON;
  /** How fast the story has this body go flat out right now, m/s (null: its own run). */
  pace: number | null = null;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  speed = 0;
  turn = 0;
  groundY = 0;
  readonly slope = new THREE.Vector2();

  private phase = 0;
  private eyeY = 0;
  private pitch = -0.04;
  private lookPitch = 0;
  private roll = 0;
  private colliders: Collider[] = [];
  /** What the head is turned to (kept up to date by whoever asked), and for how much longer. */
  private focus: { at: THREE.Vector3; left: number; still: boolean } | null = null;
  private focusPitch = 0;
  /** How far in the view has closed on what it is turned to: 1 not at all, FOCUS_ZOOM all the way. */
  zoom = 1;
  private prev = new THREE.Vector3();
  private grad = new THREE.Vector2();
  private time = 0;

  /** Footsteps taken so far: one more each time a foot lands. */
  get steps(): number {
    return Math.floor(this.phase / Math.PI);
  }

  /** How far through its footsteps the walker is: a whole number as each foot lands. */
  get stride(): number {
    return this.phase / Math.PI;
  }

  /** Whether the head is turned to something that must be seen (focusOn), out of the pointer's hands. */
  get focused(): boolean {
    return this.focus !== null;
  }

  constructor(private camera: THREE.PerspectiveCamera, private height: HeightFn) {
    this.groundY = height(0, 0);
    this.eyeY = this.groundY + this.body.eye;
    this.position.set(0, this.eyeY, 0);
    camera.rotation.order = "YXZ";
  }

  /** Puts the walker, standing, at a spot facing a heading (before the first update). */
  place(x: number, z: number, yaw: number): void {
    this.groundY = this.height(x, z);
    this.eyeY = this.groundY + this.body.eye;
    this.position.set(x, this.eyeY, z);
    this.pace = null;
    this.yaw = yaw;
    this.speed = 0;
    this.turn = 0;
    this.lookPitch = 0;
    this.pitch = -0.04;
    this.roll = 0;
    this.velocity.set(0, 0, 0);
    this.focus = null;
    this.zoom = 1;
  }

  /**
   * Turns the head to something that must be seen, whichever way it was looking: for
   * `seconds` the pointer only sets the pace (or, `still`, the walker stands rooted), and
   * the eyes stay on `at` (a point the caller keeps up to date if it moves). Then the
   * pointer has the head again, from there.
   */
  focusOn(at: THREE.Vector3, seconds: number, still = false): void {
    this.focus = { at, left: seconds, still };
  }

  /** Ground height under the walker: the snowfield, or the top of a drift or a fallen trunk being climbed. */
  private surface(x: number, z: number): number {
    const ground = this.height(x, z);
    let y = ground;
    for (const col of this.colliders) {
      if (col.log) y = Math.max(y, ridgeHeight(col.log, x, z, ground));
      const m = col.mound;
      if (!m) continue;
      const q2 = ((x - col.x) ** 2 + (z - col.z) ** 2) / (m.reach * m.reach);
      // A squashed dome like the drift itself, a little softer at the rim.
      if (q2 < 1) y = Math.max(y, m.y + m.h * (1 - q2) ** 0.65);
    }
    return y;
  }

  /** One short step forward, pushed out of and slid round whatever is in the way. */
  private advance(fwdX: number, fwdZ: number, dt: number): void {
    this.position.x += fwdX * this.speed * dt;
    this.position.z += fwdZ * this.speed * dt;
    for (let pass = 0; pass < 2; pass++) {
      for (const col of this.colliders) {
        // Low drifts and fallen trunks are walked over, not around.
        if (col.walk <= 0) continue;
        const dx = this.position.x - col.x;
        const dz = this.position.z - col.z;
        const min = col.walk + this.body.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 < min * min && d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = (min - d) / d;
          this.position.x += dx * push;
          this.position.z += dz * push;
          if (pass === 0) {
            // Walk around the obstacle instead of stalling against it head-on.
            const nx = dx / d;
            const nz = dz / d;
            const into = -(nx * fwdX + nz * fwdZ);
            if (into > 0) {
              const tx = -nz;
              const tz = nx;
              const side = tx * fwdX + tz * fwdZ >= 0 ? 1 : -1;
              const slide = into * this.speed * dt * 0.85;
              this.position.x += tx * side * slide;
              this.position.z += tz * side * slide;
            }
          }
        }
      }
    }
  }

  update(dt: number, steering: Steering, world: World, gust: number): void {
    this.time += dt;
    const [mag, angle] = steering.read();
    const walking = steering.walking;

    let targetTurn = 0;
    if (walking) {
      // Turning: proportional for small offsets, full rate from the sides and behind.
      const turnAmount = Math.sign(angle) * Math.min(1, Math.abs(angle) / (Math.PI * 0.5));
      targetTurn = mag > 0 ? turnAmount * this.body.turn * (0.45 + 0.55 * mag) : 0;
      // The gaze settles back to the path ahead.
      this.lookPitch += (0 - this.lookPitch) * (1 - Math.exp(-dt * 1.5));
    } else if (mag > 0) {
      // Standing: just turn the head.
      targetTurn = Math.sin(angle) * mag * LOOK_YAW;
      this.lookPitch = THREE.MathUtils.clamp(this.lookPitch + Math.cos(angle) * mag * LOOK_PITCH * dt, PITCH_MIN, PITCH_MAX);
    }
    const focus = this.focus;
    this.zoom += ((focus ? FOCUS_ZOOM : 1) - this.zoom) * (1 - Math.exp(-dt * FOCUS_ZOOM_RATE));
    if (focus) {
      // Swung round to look straight at it, up or down to it as well.
      const dx = focus.at.x - this.position.x;
      const dz = focus.at.z - this.position.z;
      const k = 1 - Math.exp(-dt * FOCUS_RATE);
      this.turn = 0;
      this.yaw += wrap(Math.atan2(-dx, -dz) - this.yaw) * k;
      this.focusPitch = THREE.MathUtils.clamp(Math.atan2(focus.at.y - this.position.y, Math.hypot(dx, dz)), PITCH_MIN, PITCH_MAX);
      focus.left -= dt;
    } else {
      this.turn += (targetTurn - this.turn) * (1 - Math.exp(-dt * 4));
      this.yaw -= this.turn * dt;
    }

    // Forward pace: full when aiming ahead, slower while turning or turning around.
    const c = Math.cos(angle);
    const heading = c >= 0 ? 0.35 + 0.65 * c : 0.35 + 0.15 * c;
    const fwdX = -Math.sin(this.yaw);
    const fwdZ = -Math.cos(this.yaw);
    heightGradient(this.height, this.position.x, this.position.z, this.grad);
    const uphill = this.grad.x * fwdX + this.grad.y * fwdZ;
    const slopeFactor = slopePace(uphill);
    const body = this.body;
    const run = this.pace ?? body.run;
    const walk = Math.min(body.walk, run);
    const rooted = focus?.still ?? false;
    const targetSpeed = walking && mag > 0 && !rooted ? (walk + (run - walk) * mag ** body.urge) * heading * slopeFactor : 0;
    const k = targetSpeed > this.speed ? 1.6 : 2.8;
    this.speed += (targetSpeed - this.speed) * (1 - Math.exp(-dt * k));
    if (this.speed < 0.01 && targetSpeed === 0) this.speed = 0;

    this.prev.copy(this.position);
    // Slide around trunks and drifts instead of walking through them. A long frame is taken
    // in short steps, so a slow one never carries the walker through anything thin.
    world.collidersNear(this.position.x, this.position.z, this.colliders);
    const steps = Math.min(8, Math.max(1, Math.ceil((this.speed * dt) / MAX_STEP)));
    for (let step = 0; step < steps; step++) this.advance(fwdX, fwdZ, dt / steps);

    // Heavy steps in deep snow.
    const stepRate = this.speed > 0.05 ? (1.5 + this.speed * 0.3) * body.cadence : 0;
    this.phase += dt * stepRate * Math.PI;
    const moving = Math.min(1, this.speed / 1.2);
    const bobAmp = (0.03 + this.speed * 0.011) * moving * body.sway;
    const bob = (Math.abs(Math.sin(this.phase)) - 0.6) * bobAmp;
    const breathe = Math.sin(this.time * 1.6) * 0.006 * (1 - moving);

    this.groundY = this.surface(this.position.x, this.position.z);
    this.slope.copy(heightGradient(this.height, this.position.x, this.position.z, this.grad));
    this.eyeY += (this.groundY + body.eye - this.eyeY) * (1 - Math.exp(-dt * 8));
    this.position.y = this.eyeY + bob + breathe;

    const shake = gust * gust * 0.004;
    const pathPitch = THREE.MathUtils.clamp(-0.05 + uphill * 0.35 * moving, -0.22, 0.12);
    if (focus && focus.left <= 0) {
      // Let go: the gaze stays where it was, and (walking) settles back to the path from there.
      this.lookPitch = this.focusPitch - pathPitch;
      this.focus = null;
    }
    const gaze = this.focus ? this.focusPitch : THREE.MathUtils.clamp(pathPitch + this.lookPitch, PITCH_MIN, PITCH_MAX);
    const targetPitch = gaze + wave1(this.time * 7.1, 3.3) * shake;
    this.pitch += (targetPitch - this.pitch) * (1 - Math.exp(-dt * 5));
    const targetRoll = Math.sin(this.phase) * 0.012 * moving * body.sway + this.turn * 0.025 + wave1(this.time * 5.3, 9.1) * shake;
    this.roll += (targetRoll - this.roll) * (1 - Math.exp(-dt * 6));

    this.camera.position.copy(this.position);
    this.camera.rotation.set(this.pitch, this.yaw + Math.sin(this.phase * 0.5) * 0.006 * moving * body.sway, this.roll);

    if (dt > 0) this.velocity.subVectors(this.position, this.prev).divideScalar(dt);
  }
}
