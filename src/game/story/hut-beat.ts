import * as THREE from "three";
import { Hut } from "../props/hut";
import type { Collider } from "../world/collider";
import { forward, type Stage } from "./context";
import {
  DOOR_FACING,
  DOOR_REACH,
  HUT_AGAIN,
  HUT_AGAIN_ASIDE,
  HUT_AGAIN_BEARINGS,
  HUT_AGAIN_DEEPER,
  HUT_AGAIN_MIN,
  HUT_ASIDE,
  HUT_BEARINGS,
  HUT_DIST,
  HUT_LOST,
  HUT_MISSED_FOR,
  HUT_NEARER,
  HUT_OFF_COURSE,
  HUT_REST,
  HUT_RETRY,
  HUT_RUNNING,
  HUT_UNEVEN,
  HUT_UNSEEN
} from "./tuning";

/**
 * The hut. Turning to run from the yeti brings it out of the fog well ahead, on the
 * levellest ground there, cleared of trees, its door facing the walker. Run past without
 * finding it, and it stands ahead again, as often as it takes.
 */
export class HutBeat {
  readonly hut: Hut;
  private colliders: Collider[] = [];
  /** Seconds the hut has been off the way run, times it has been put ahead again, and the wait before another try. */
  private missed = 0;
  private moves = 0;
  private retry = 0;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  constructor(
    private stage: Stage,
    woodMaterial: THREE.Material
  ) {
    this.hut = new Hut(woodMaterial);
  }

  reset(): void {
    this.hut.hide();
    this.colliders = [];
    this.missed = 0;
    this.moves = 0;
    this.retry = 0;
  }

  /** Where the walker turns to run: the hut goes ahead of them there. False when no ground will take it. */
  raise(): boolean {
    const [fx, fz] = forward(this.stage.walker);
    return this.place(fx, fz, HUT_DIST, HUT_BEARINGS, HUT_ASIDE);
  }

  /** Whether the walker has reached the door: close enough, in front of it, facing in. */
  atDoor(): boolean {
    const p = this.stage.walker.position;
    const h = this.hut;
    const [fx, fz] = forward(this.stage.walker);
    const step = h.doorstep(this.tmp, 0.5);
    const sd = Math.hypot(step.x - p.x, step.z - p.z);
    const into = h.doorstep(this.tmp2, -1.5);
    const ix = into.x - p.x;
    const iz = into.z - p.z;
    const facing = (ix * fx + iz * fz) / (Math.hypot(ix, iz) || 1);
    return sd < DOOR_REACH && h.frontOf(p.x, p.z) > -0.1 && facing > DOOR_FACING;
  }

  /**
   * Run past the hut without finding it, and it stands ahead again, straight on the way
   * you are running, as often as it takes. Never where it could be seen to: the old one
   * out of view and lost in the fog, the new one beyond what the fog lets through.
   * True when it has just been moved.
   */
  passed(dt: number): boolean {
    const w = this.stage.walker;
    const p = w.position;
    const h = this.hut.position;
    const hx = h.x - p.x;
    const hz = h.z - p.z;
    const hd = Math.hypot(hx, hz);
    // The way you are going is the way you face: there is no walking sideways.
    const [cx, cz] = forward(w);
    const sp = Math.hypot(w.velocity.x, w.velocity.z);
    // Standing still neither counts towards having missed it nor forgets how long it has been.
    const astray = hd > HUT_UNSEEN && (hx * cx + hz * cz) / hd < HUT_OFF_COURSE;
    if (!astray) this.missed = 0;
    else if (sp >= HUT_RUNNING) this.missed += dt;
    this.retry -= dt;
    if (this.retry > 0 || (hd <= HUT_LOST && this.missed < HUT_MISSED_FOR)) return false;
    if (this.stage.sight.inView(h.x, h.z, 2, 6)) return false;
    const near = Math.max(HUT_AGAIN_MIN, HUT_AGAIN - HUT_NEARER * this.moves);
    if (!this.place(cx, cz, HUT_AGAIN_DEEPER.map((more) => near + more), HUT_AGAIN_BEARINGS, HUT_AGAIN_ASIDE)) {
      this.retry = HUT_RETRY;
      return false;
    }
    this.moves++;
    this.missed = 0;
    this.retry = HUT_REST;
    return true;
  }

  /**
   * Ahead along (fx, fz), far enough that the fog hides it: the levellest ground there,
   * cleared of trees, the door facing your way. It goes one of `dists` metres off (the
   * first for choice), on one of `bearings` (radians off straight ahead), a radian aside
   * costing `aside` in the score; ahead of the walker, or of `p` with its door facing that
   * way, and only where `allowed`. Wherever it stood before, it is gone from.
   */
  place(
    fx: number,
    fz: number,
    dists: number[],
    bearings: number[],
    aside: number,
    p: THREE.Vector3 = this.stage.walker.position,
    allowed: (x: number, z: number) => boolean = () => true
  ): boolean {
    const { world, height } = this.stage;
    const ahead = Math.atan2(fx, fz);
    let best: { x: number; z: number; y: number; score: number } | null = null;
    for (const off of bearings) {
      for (const d of dists) {
        const x = p.x + Math.sin(ahead + off) * d;
        const z = p.z + Math.cos(ahead + off) * d;
        if (!allowed(x, z)) continue;
        const yaw = Math.atan2(p.x - x, p.z - z);
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        let lo = Infinity;
        let hi = -Infinity;
        for (const [lx, lz] of Hut.FOOTPRINT) {
          const g = height(x + lx * c + lz * s, z - lx * s + lz * c);
          lo = Math.min(lo, g);
          hi = Math.max(hi, g);
        }
        // Too steep for a level clearing to sit naturally in the slope: not here.
        if (hi - lo > HUT_UNEVEN) continue;
        const score = -(hi - lo) - Math.abs(off) * aside - (d === dists[0] ? 0 : 0.2);
        // Level the clearing at the middle of the slope, so the snow blends gently all round.
        if (!best || score > best.score) best = { x, z, y: (lo + hi) * 0.5, score };
      }
    }
    if (!best) return false;
    // The clearing where it stood stays bare until clearProps(): nothing grows back in sight.
    world.removeColliders(this.colliders);
    world.clear(best.x, best.z, Hut.CLEARING, { y: best.y, flat: Hut.PAD });
    this.hut.place(best.x, best.y + Hut.STEP, best.z, p.x - best.x, p.z - best.z);
    this.colliders = this.hut.colliders();
    world.addColliders(this.colliders);
    return true;
  }

  dispose(): void {
    this.hut.dispose();
  }
}
