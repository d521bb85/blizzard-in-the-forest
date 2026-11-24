import * as THREE from "three";
import { EYE } from "../actors/player";
import { BOARD_H, BOARD_W, BOARD_Y, Signpost } from "../props/sign";
import type { Collider } from "../world/collider";
import { heightGradient } from "../world/terrain";
import { forward, lineClear, roomy, type Stage } from "./context";
import { Course } from "./course";
import {
  CLOSE_EDGE,
  MOVING,
  READ_CLOSE,
  READ_DIST,
  READ_EDGE,
  READ_SHARE,
  READ_TIME,
  SHOW_DIST,
  SHOW_EDGE,
  SHOW_SHARE,
  SIGN_AFTER,
  SIGN_AGAIN,
  SIGN_ASIDE,
  SIGN_DEEPER,
  SIGN_EASES_AFTER,
  SIGN_HIDE,
  SIGN_KEPT,
  SIGN_LOST,
  SIGN_MAX,
  SIGN_MIN,
  SIGN_NOTICED,
  SIGN_OFF_FOR,
  SIGN_PASSED,
  SIGN_PER_FRAME,
  SIGN_READ_FROM,
  SIGN_RETRY,
  SIGN_RIM,
  SIGN_SEEN_FROM,
  SIGN_SLOPE,
  SIGN_STEP,
  SIGN_STRAIGHT,
  SIGN_UNSETTLED
} from "./tuning";

/** The post and its board, for judging whether any of it is on screen: a ball this big, this high above the snow. */
const BALL_UP = 1;
const BALL = 1.5;
/** How far round the way ahead the forest is looked over for a spot, m. */
const SEARCH_PAD = 10;

/**
 * The signpost. After a minute's walking, a change of direction stands it ahead on the
 * new heading: far enough off that the fog hides it, so the walker comes up to it as it
 * comes out of the fog. Walked past unread and left behind, it is taken away unseen and
 * comes again the same way, for as long as it stays unread. Reading it (near enough, from
 * in front, for a moment) is what sets the rest of the story going.
 */
export class SignBeat {
  readonly post: Signpost;
  /** Whether the words have been read. */
  read = false;
  private course = new Course();
  /** Whether the post is standing somewhere. */
  private up = false;
  private colliders: Collider[] = [];
  /** Seconds of walking until one may come; once it may, seconds walked without a turn. */
  private wait = SIGN_AFTER;
  private straight = 0;
  /** One is to be put ahead as soon as there is a place for it; for how many seconds of walking that has been so. */
  private due = false;
  private dueFor = 0;
  /** For trying the story out: put ahead at once, standing or walking; read at once. */
  private forced = false;
  /** The search for a place: a few spots a frame, all judged from where it began. */
  private seek = { at: 0, wait: 0, rounds: 0, x: 0, z: 0, fx: 0, fz: 0, dist: 0, side: 1 };
  private near: Collider[] = [];
  /** Standing: seconds looked at, whether it has been seen at all, and seconds off screen. */
  private gaze = 0;
  private seen = false;
  private offFor = 0;
  private showing = false;
  private scratch: Collider[] = [];
  private clip = new THREE.Vector4();
  private grad = new THREE.Vector2();

  constructor(
    private stage: Stage,
    woodMaterial: THREE.Material,
    /** Told whenever the carved words come on screen or go from it. */
    private onWords: (visible: boolean) => void
  ) {
    this.post = new Signpost(woodMaterial);
  }

  /** 0..1: how close the signpost is to appearing (1 once due, standing, or read). */
  get progress(): number {
    if (this.read || this.up || this.due) return 1;
    return THREE.MathUtils.clamp(1 - this.wait / SIGN_AFTER, 0, 1);
  }

  setLines(lines: readonly string[]): void {
    this.post.setLines(lines);
  }

  reset(): void {
    this.take();
    this.hush();
    this.course.reset();
    this.read = false;
    this.wait = SIGN_AFTER;
    this.straight = 0;
    this.due = false;
    this.dueFor = 0;
    this.forced = false;
    this.seek.at = 0;
    this.seek.wait = 0;
    this.seek.rounds = 0;
  }

  /** For trying the story out: a sign ahead now; or, standing unread, read now. */
  skip(): void {
    if (this.read) return;
    this.forced = true;
    if (!this.up) {
      this.wait = 0;
      this.due = true;
      this.seek.wait = 0;
    }
  }

  /** Takes the words off the screen (they come back, while `words` allows, when the board is looked at). */
  hush(): void {
    if (!this.showing) return;
    this.showing = false;
    this.onWords(false);
  }

  /**
   * Call every frame of the walk; `words` says whether the carved words may show.
   * True on the frame the sign is read.
   */
  update(dt: number, words: boolean): boolean {
    const { walker, steering } = this.stage;
    const turned = this.course.update(dt, walker, steering);
    if (this.up) return this.watch(dt, words);
    if (this.read) return false;
    const moving = steering.walking && Math.hypot(walker.velocity.x, walker.velocity.z) >= MOVING;
    if (moving) this.wait -= dt;
    if (!this.due && this.wait <= 0) {
      if (moving) this.straight += dt;
      if (turned || this.straight >= SIGN_STRAIGHT) this.due = true;
    }
    if (this.due) {
      if (moving) this.dueFor += dt;
      this.search(dt, moving);
    }
    return false;
  }

  /**
   * Looks for a place ahead, a few spots a frame: first on the way, just to one side of
   * it, then further off and further aside. Only once the heading has settled, so that
   * ahead is where the walker is going.
   */
  private search(dt: number, moving: boolean): void {
    const s = this.seek;
    const { walker, world, sight } = this.stage;
    const ready = this.forced || (moving && (this.course.settled || this.dueFor >= SIGN_UNSETTLED));
    if (!ready) {
      s.at = 0;
      return;
    }
    if ((s.wait -= dt) > 0) return;
    if (s.at === 0) {
      [s.fx, s.fz] = forward(walker);
      s.x = walker.position.x;
      s.z = walker.position.z;
      s.side = this.stage.rand() < 0.5 ? 1 : -1;
      s.dist = THREE.MathUtils.clamp(sight.hiddenBeyond(SIGN_HIDE), SIGN_MIN, Math.min(SIGN_MAX, world.radius - SIGN_RIM));
      const reach = s.dist + SIGN_DEEPER[SIGN_DEEPER.length - 1] + SEARCH_PAD;
      const ex = s.x + s.fx * reach;
      const ez = s.z + s.fz * reach;
      world.collidersIn(
        Math.min(s.x, ex) - SEARCH_PAD,
        Math.min(s.z, ez) - SEARCH_PAD,
        Math.max(s.x, ex) + SEARCH_PAD,
        Math.max(s.z, ez) + SEARCH_PAD,
        this.near
      );
    }
    const total = SIGN_ASIDE.length * SIGN_DEEPER.length;
    for (let n = 0; n < SIGN_PER_FRAME && s.at < total; n++, s.at++) {
      const aside = SIGN_ASIDE[Math.floor(s.at / SIGN_DEEPER.length)] * s.side;
      const dist = s.dist + SIGN_DEEPER[s.at % SIGN_DEEPER.length];
      if (this.tryPlace(dist, aside)) return;
    }
    if (s.at >= total) {
      s.at = 0;
      s.rounds++;
      s.wait = SIGN_RETRY;
    }
  }

  /**
   * Stands the post `dist` metres along the way and `aside` to its right, if it will do
   * there: on loaded, open, fairly level ground, with nothing between it and the walker
   * coming up the way. After a few fruitless rounds only the tests that matter up close remain.
   */
  private tryPlace(dist: number, aside: number): boolean {
    const s = this.seek;
    const { world, height, sight } = this.stage;
    const eased = s.rounds >= SIGN_EASES_AFTER;
    // Where the way passes the board, where the post stands, and two points on the way before it.
    const bx = s.x + s.fx * dist;
    const bz = s.z + s.fz * dist;
    const x = bx - s.fz * aside;
    const z = bz + s.fx * aside;
    const rx = bx - s.fx * SIGN_READ_FROM;
    const rz = bz - s.fz * SIGN_READ_FROM;
    const fx = bx - s.fx * SIGN_SEEN_FROM;
    const fz = bz - s.fz * SIGN_SEEN_FROM;
    if (!world.loaded(x, z, 6)) return false;
    if (!roomy(this.near, x, z, BOARD_W / 2 + (eased ? 0.25 : 0.5))) return false;
    // Trunks and their lower boughs up close; trunks alone further back.
    if (!lineClear(this.near, rx, rz, x, z, (c) => (c.walk > 0 ? Math.max(c.walk, c.r * 0.5) + 0.25 : 0))) return false;
    if (!eased && !lineClear(this.near, fx, fz, x, z, (c) => (c.walk > 0 ? c.walk + 0.15 : 0))) return false;
    const ground = height(x, z);
    if (Math.abs(ground - height(rx, rz)) > SIGN_STEP) return false;
    if (heightGradient(height, x, z, this.grad).length() > SIGN_SLOPE) return false;
    // The whole board over the snow from where it is read; its middle from further back.
    if (!sight.overSnowFrom(rx, height(rx, rz) + EYE, rz, x, z, BOARD_Y - BOARD_H / 2 + 0.1, 12)) return false;
    if (!eased && !sight.overSnowFrom(fx, height(fx, fz) + EYE, fz, x, z, BOARD_Y, 12)) return false;

    // Turned to face whoever comes up the way.
    this.post.place(x, z, rx - x, rz - z, height);
    this.colliders = this.post.colliders();
    world.addColliders(this.colliders);
    this.up = true;
    this.forced = false;
    this.gaze = 0;
    this.seen = false;
    this.offFor = 0;
    this.due = false;
    this.dueFor = 0;
    this.straight = 0;
    s.at = 0;
    s.rounds = 0;
    return true;
  }

  /** The post is standing: has it been seen, is it being read, has it been left behind? */
  private watch(dt: number, words: boolean): boolean {
    const { walker, sight } = this.stage;
    const p = walker.position;
    const s = this.post.position;
    const dx = s.x - p.x;
    const dz = s.z - p.z;
    const d = Math.hypot(dx, dz);
    const on = sight.inView(s.x, s.z, BALL_UP, BALL);
    if (on && d < sight.seenWithin(SIGN_NOTICED)) this.seen = true;
    this.offFor = on ? 0 : this.offFor + dt;
    // Only from in front of the board: the words are on that side.
    const front = (-dx * this.post.facing.x - dz * this.post.facing.y) / (d || 1) > 0.2;

    let justRead = false;
    if (!this.read) {
      const reading =
        front && d < READ_DIST && this.boardShare(READ_EDGE) >= READ_SHARE && sight.overSnow(p, s.x, s.z, BOARD_Y) && this.sightClear(s.x, s.z);
      this.gaze = reading ? this.gaze + dt : Math.max(0, this.gaze - dt * 2);
      if (this.gaze >= READ_TIME || this.forced) {
        this.read = true;
        this.forced = false;
        justRead = true;
      }
    }
    if (this.read) {
      const show = words && front && d < SHOW_DIST && this.boardShare(SHOW_EDGE) >= SHOW_SHARE && this.sightClear(s.x, s.z);
      if (show !== this.showing) {
        this.showing = show;
        this.onWords(show);
      }
    }

    // Left behind: gone once it is out of view and the fog has it. Read, it is kept much longer,
    // for whoever comes back to look at it again.
    const lost = this.read ? SIGN_KEPT : Math.max(SIGN_PASSED, sight.hiddenBeyond(SIGN_LOST));
    if (this.offFor >= SIGN_OFF_FOR && d > lost) {
      this.take();
      this.hush();
      if (!this.read) {
        if (this.seen) {
          // Seen and passed by: the next change of direction (or a long straight) brings another.
          this.wait = SIGN_AGAIN;
          this.straight = 0;
        } else {
          // Never seen (the walker turned off before it came out of the fog): simply ahead again.
          this.due = true;
          this.dueFor = 0;
          this.seek.wait = 1;
        }
      }
    }
    return justRead;
  }

  /** No trunk between the eyes and the post (its own board aside). */
  private sightClear(x: number, z: number): boolean {
    const p = this.stage.walker.position;
    const around = this.stage.world.collidersNear((x + p.x) / 2, (z + p.z) / 2, this.scratch);
    return lineClear(around, p.x, p.z, x, z, (c) => (c.walk <= 0 || c.mound || this.colliders.includes(c) ? 0 : c.walk));
  }

  /**
   * How much of the screen's width the board takes up as seen from here (0..1), or 0
   * unless all four corners are on screen, within `edge` of the middle (1 is the edge).
   */
  private boardShare(edge: number): number {
    const projView = this.stage.sight.projView;
    const s = this.post.position;
    const f = this.post.facing;
    const rx = (f.y * BOARD_W) / 2;
    const rz = (-f.x * BOARD_W) / 2;
    let lo = Infinity;
    let hi = -Infinity;
    let whole = true;
    for (let side = -1; side <= 1; side += 2) {
      for (let up = -1; up <= 1; up += 2) {
        const c = this.clip.set(s.x + rx * side, s.y + BOARD_Y + (up * BOARD_H) / 2, s.z + rz * side, 1).applyMatrix4(projView);
        if (c.w < 0.05) {
          // Beside or behind the eye: off the screen on that side.
          whole = false;
          if (c.x < 0) lo = -Infinity;
          else hi = Infinity;
          continue;
        }
        const x = c.x / c.w;
        if (Math.abs(x) > edge || Math.abs(c.y / c.w) > edge) whole = false;
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    }
    if (!whole) {
      // Right up against it the board spills off the screen: its middle in view will do.
      const c = this.clip.set(s.x, s.y + BOARD_Y, s.z, 1).applyMatrix4(projView);
      const p = this.stage.walker.position;
      const near = Math.hypot(s.x - p.x, s.z - p.z) < READ_CLOSE;
      if (!near || c.w < 0.05 || Math.abs(c.x / c.w) > CLOSE_EDGE) return 0;
    }
    return (Math.min(hi, 1) - Math.max(lo, -1)) / 2;
  }

  /** Takes the post away (only ever unseen, or with the screen black). */
  private take(): void {
    if (!this.up && !this.post.group.visible) return;
    this.up = false;
    this.post.hide();
    this.stage.world.removeColliders(this.colliders);
    this.colliders = [];
  }

  dispose(): void {
    this.post.dispose();
  }
}
