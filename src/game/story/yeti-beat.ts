import * as THREE from "three";
import { ROAR_TIME, Yeti } from "../actors/yeti";
import type { Collider } from "../world/collider";
import { forward, heard, type Stage } from "./context";
import {
  AWAY,
  CAUGHT,
  GROWL_EVERY,
  GROWL_FIRST,
  GROWL_SPREAD,
  LEASH,
  LEASH_SLACK,
  YETI_APPROACH,
  YETI_BEARINGS,
  YETI_DEEPER,
  YETI_EMERGES,
  YETI_FAR,
  YETI_FRONT,
  YETI_FOCUS,
  YETI_FRONT_MAX,
  YETI_HIDE,
  YETI_LEAD,
  YETI_LOST,
  YETI_MET,
  YETI_NEAR,
  YETI_OFF,
  YETI_PATIENCE,
  YETI_RIM,
  YETI_ROAR_GAP,
  YETI_ROAR_SEEN,
  YETI_SHIFT,
  YETI_SHOWS,
  YETI_STALK,
  YETI_VEILED
} from "./tuning";

/** The yeti, for judging whether any of it is on screen: a ball this big, this high above the snow. */
const BALL_UP = 1.3;
const BALL = 1.9;
/** Its head, about: what must show over the snow for it to be seen rearing up. */
const HEAD_UP = 2;
/** It needs this much room round it to start from a spot. */
const ROOM = 0.9;

/**
 * The yeti's part. It comes head-on: set walking dead ahead of the walker, far enough off
 * that the fog hides it, so that it is first a shape in the fog straight in front, then a
 * figure coming on. Until it has been seen it is kept in front, whatever way the walker
 * turns: moved while the fog still veils it, and steering for the way ahead of them after
 * that. In view and near enough to be made out, it rears up and roars; then it runs.
 */
export class YetiBeat {
  readonly yeti = new Yeti();
  /** It has roared: the chase is on. */
  met = false;
  /** Set on the frame it roars; cleared by whoever acts on it. */
  justRoared = false;
  private growlIn = 0;
  /** Coming on: seconds since it was set walking, seconds seen, seconds off screen, seconds until it may be put ahead again. */
  private since = 0;
  private seenFor = 0;
  private offFor = 0;
  private shiftIn = 0;
  private forced = false;
  private colliders: Collider[] = [];
  private spot = new THREE.Vector2();
  private aim = new THREE.Vector3();

  constructor(private stage: Stage) {}

  reset(): void {
    this.yeti.hide();
    this.met = false;
    this.justRoared = false;
    this.forced = false;
  }

  /** For trying the story out: it roars where it is, now. */
  skip(): void {
    this.forced = true;
  }

  /** Dead ahead, beyond what the fog lets through, walking this way. */
  spawn(): boolean {
    const p = this.stage.walker.position;
    const at = this.ahead();
    this.yeti.spawn(at.x, at.y, Math.atan2(p.x - at.x, p.z - at.y));
    this.met = false;
    this.justRoared = false;
    this.forced = false;
    this.since = 0;
    this.seenFor = 0;
    this.offFor = 0;
    this.shiftIn = YETI_SHIFT;
    this.growlIn = GROWL_FIRST + this.stage.rand() * 3;
    return true;
  }

  /** How far it is from the walker, over the ground. */
  get distance(): number {
    const p = this.stage.walker.position;
    return Math.hypot(this.yeti.position.x - p.x, this.yeti.position.z - p.z);
  }

  /** Its hands are on the walker. */
  get reached(): boolean {
    return this.distance < CAUGHT;
  }

  /** The walker has turned to run from it. */
  get fled(): boolean {
    const p = this.stage.walker.position;
    const y = this.yeti.position;
    const [fx, fz] = forward(this.stage.walker);
    return ((y.x - p.x) * fx + (y.z - p.z) * fz) / (this.distance || 1) < AWAY;
  }

  /** While it is not part of the story (stood somewhere with preview() to be looked over), it still moves. */
  idle(dt: number): void {
    if (this.yeti.state === "preview") this.yeti.update(dt, this.stage.walker.position, this.stage.world, this.stage.height);
  }

  update(dt: number): void {
    const { walker, world, height, cues } = this.stage;
    const y = this.yeti;
    // Before the roar it makes for the way ahead of the walker, so as to come at them from in front.
    y.update(dt, this.met ? walker.position : this.wayAhead(), world, height);
    if (!this.met) this.comeOn(dt);

    if (y.roared) {
      y.roared = false;
      const [pan, level] = heard(walker, y.position.x, y.position.z, 70);
      cues.cue?.("growl", pan, Math.max(0.35, level));
    }
    if (y.stomp > 0) {
      const [pan, level] = heard(walker, y.position.x, y.position.z, 40);
      if (level > 0.01) cues.cue?.("stomp", pan, level * y.stomp);
      y.stomp = 0;
    }
    // Running, it snarls now and then, nearer and nearer.
    if (y.state === "chase") {
      this.growlIn -= dt;
      if (this.growlIn <= 0) {
        this.growlIn = GROWL_EVERY + this.stage.rand() * GROWL_SPREAD;
        const [pan, level] = heard(walker, y.position.x, y.position.z, 45);
        if (level > 0.05) cues.cue?.("growl", pan, level * 0.7);
      }
    }
  }

  /** A point on the way ahead of the walker, a share of the distance to the yeti along it. */
  private wayAhead(): THREE.Vector3 {
    const p = this.stage.walker.position;
    const [fx, fz] = forward(this.stage.walker);
    const lead = this.distance * YETI_LEAD;
    return this.aim.set(p.x + fx * lead, p.y, p.z + fz * lead);
  }

  /**
   * Before the roar. Unseen, it is kept dead ahead and comes on at a stride; showing, it
   * walks. It roars in view, near enough to be made out, or at once when the walker, having
   * seen it, turns to run.
   */
  private comeOn(dt: number): void {
    const { walker, sight } = this.stage;
    const y = this.yeti;
    const p = walker.position;
    const dx = y.position.x - p.x;
    const dz = y.position.z - p.z;
    const dist = Math.hypot(dx, dz) || 1;
    const [fx, fz] = forward(walker);
    const ahead = (dx * fx + dz * fz) / dist;
    // Three ways of being in sight. `on`: some of it might be on screen, so it may not be moved
    // (a generous ball round it). `shows`: its middle is in the picture. `front`: and that
    // well inside the view, about where the walker is looking.
    const on = sight.inView(y.position.x, y.position.z, BALL_UP, BALL);
    const shows = sight.inView(y.position.x, y.position.z, BALL_UP, 0);
    const front = shows && ahead > Math.cos(Math.min(sight.halfView * YETI_FRONT, YETI_FRONT_MAX));
    this.since += dt;
    this.shiftIn -= dt;
    this.offFor = on ? 0 : this.offFor + dt;
    if (front && dist < sight.seenWithin(YETI_SHOWS)) this.seenFor += dt;
    const known = this.seenFor >= YETI_MET;
    const patient = this.since < YETI_PATIENCE;
    y.pace = dist > sight.seenWithin(YETI_EMERGES) ? YETI_APPROACH : YETI_STALK;

    // As far off as the walker has time to turn from, however fast they are coming at it.
    const closing = Math.max(0, (walker.velocity.x * dx + walker.velocity.z * dz) / dist);
    const roarAt = Math.max(YETI_ROAR_GAP, Math.min(YETI_ROAR_GAP + ROAR_TIME * closing, sight.seenWithin(YETI_ROAR_SEEN)));
    const plain = shows && sight.overSnow(p, y.position.x, y.position.z, HEAD_UP);
    // Seen, or waited for long enough: turning away from it is running, and it roars at once.
    const fleeing = (known || !patient) && ahead < AWAY;
    if (this.forced || fleeing || (dist <= roarAt && (plain || !patient || dist <= YETI_ROAR_GAP - 4))) {
      // The walker is turned to look at it first, rooted to the spot: the roar lasts that much
      // longer, so they still have ROAR_TIME to turn and run.
      y.roar(ROAR_TIME + YETI_FOCUS);
      this.met = true;
      this.justRoared = true;
      return;
    }
    if (!patient) {
      // Come for regardless: wherever the walker goes, it is not left behind.
      this.leash();
      return;
    }
    if (known) return;
    // Not yet seen. While the fog still veils it, it keeps dead ahead as the walker turns, as
    // far off as it has come, so no ground is lost.
    if (ahead < YETI_OFF && dist > sight.hiddenBeyond(YETI_VEILED)) {
      y.teleport(p.x + fx * dist, p.z + fz * dist, p);
      this.offFor = 0;
      return;
    }
    // Nearer than that and out of view: dead ahead again, back in the fog. Where it goes is as
    // hidden as where it started: nothing is seen to arrive.
    if (this.shiftIn <= 0 && this.offFor >= YETI_LOST) {
      const at = this.ahead();
      y.teleport(at.x, at.y, p);
      this.offFor = 0;
      this.seenFor = 0;
      this.shiftIn = YETI_SHIFT;
    }
  }

  /**
   * A spot dead ahead of the walker where the fog, even in a thin streak, hides it:
   * the first with room to stand, straight in front for choice.
   */
  private ahead(): THREE.Vector2 {
    const { walker, world, sight } = this.stage;
    const p = walker.position;
    const [fx, fz] = forward(walker);
    const bearing = Math.atan2(fx, fz);
    const dist = THREE.MathUtils.clamp(sight.hiddenBeyond(YETI_HIDE), YETI_NEAR, Math.min(YETI_FAR, world.radius - YETI_RIM));
    for (const off of YETI_BEARINGS) {
      for (const more of YETI_DEEPER) {
        const x = p.x + Math.sin(bearing + off) * (dist + more);
        const z = p.z + Math.cos(bearing + off) * (dist + more);
        let blocked = false;
        for (const c of world.collidersNear(x, z, this.colliders)) {
          if (c.walk > 0 && Math.hypot(c.x - x, c.z - z) < c.walk + ROOM) {
            blocked = true;
            break;
          }
        }
        if (!blocked) return this.spot.set(x, z);
      }
    }
    // Trees everywhere: straight ahead anyway; it shoulders its way out from among them.
    return this.spot.set(p.x + fx * dist, p.z + fz * dist);
  }

  /** Never so far behind it gives up: out of sight, it closes in to the leash. */
  leash(): void {
    const { walker, sight } = this.stage;
    const y = this.yeti;
    const p = walker.position;
    const dx = y.position.x - p.x;
    const dz = y.position.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= LEASH || sight.inView(y.position.x, y.position.z, BALL_UP, BALL)) return;
    const k = (LEASH - LEASH_SLACK) / dist;
    const nx = p.x + dx * k;
    const nz = p.z + dz * k;
    if (!sight.inView(nx, nz, BALL_UP, BALL)) y.teleport(nx, nz, p);
  }

  dispose(): void {
    this.yeti.dispose();
  }
}
