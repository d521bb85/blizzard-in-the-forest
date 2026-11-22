import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { TAU, wrap } from "../lib/math";
import { coreRadius, type Collider } from "../world/collider";
import type { Sight } from "../world/sight";
import type { HeightFn } from "../world/terrain";
import type { World } from "../world/world";
import { createCoatMaterial, ellipsoid, loft, paint, rod, type CoatPalette } from "./creature";
import { ArcPlanner } from "./route";
import { HEADINGS, freeDistance } from "./steer";

const HIP_Y = 0.92;
/** To the eyes that see heat a deer glows through its winter coat, not as hot as bare skin. */
const DEER_WARMTH = 0.6;
const UPPER = 0.45;
const LOWER = 0.47;
/**
 * Deer keep their distance. They cross on an arc around the walker, 17-22 m
 * out, deep enough in the fog to be half there; never head towards the walker;
 * bolt when the walker comes at them, outrunning anyone, until the fog takes
 * them; and are fully gone before anyone could get close, whatever else happens.
 */
const RING_NEAR = 17;
const RING_FAR = 22;
/** The arc drifts this much further out from start to end, so a crossing only ever recedes. */
const RING_DRIFT = 3;
/** Closer than this, they bolt. */
/** A little beyond VEIL_NEAR, so a deer is already on its way before the near veil could touch it. */
const ALARM = 16;
/** Within this distance, a walker coming at them faster than CLOSING also makes them bolt. */
const SIGHT = 26;
const CLOSING = 1.1;
/** Hard limit: dissolving from VEIL_NEAR, completely gone at VEIL_GONE. */
const VEIL_NEAR = 14;
const VEIL_GONE = 10;
/**
 * Far out the veil closes too, so nothing is ever dropped while it can still be seen: from
 * VEIL_FAR to FAR, and further in clearer air, out where the fog itself lets through only
 * FAR_DIM, then FAR_DARK, of a deer even in a thin streak.
 */
const VEIL_FAR = 36;
const FAR = 44;
const FAR_DIM = 0.1;
const FAR_DARK = 0.02;
/** Share of the arc a route must cover to be worth starting (nodes are about a metre apart); past its end a deer walks on anyway. */
const MIN_COVER = 0.55;
const WALK_SPEED = 1.7;
/** A bounding run, well clear of the walker's fastest (6.2 m/s), so the gap only grows. */
const FLEE_SPEED = 9.5;
/**
 * The most a heading may point towards the walker (a cosine). Walking, a deer may
 * edge in by a few degrees to get round a tree; fleeing, it must be heading away.
 */
const WALK_APPROACH = 0.15;
const FLEE_APPROACH = -0.4;
/** Hard cap on actual movement towards the walker, m/s, whatever steering or a trunk does. */
const MAX_CLOSING_WALK = 0.12;
/**
 * Deer come and go out of sight. A crossing starts just past the edge of the view
 * (by this much, in radians), so the deer walks into it rather than appearing in it.
 */
const EDGE = 0.18;
/** Done with its crossing, a deer walks on (a little quicker, edging away) until out of sight. */
const LEAVE_SPEED = WALK_SPEED * 1.25;
/**
 * Leaving, a deer the walker keeps after (closing in at all, out to VEIL_FAR) bolts;
 * one still in sight after LEAVE_MAX bolts too. Either way it runs off into the fog.
 */
const FOLLOWED = 0.4;
const LEAVE_MAX = 40;
/** The opening crossing may appear in view only this early, while the scene is still dark. */
const OPENING_WINDOW = 0.5;
/** Room around a deer when judging whether any of it is still on screen, m. */
const VIEW_PAD = 1.8;
/** A deer on its way off is put away once it has been off screen this long, s: a glance back still finds it going. */
const UNSEEN_FOR = 1.5;
/**
 * A fleeing deer is not dissolved on the spot: it runs on until the fog has it
 * (the far veil, VEIL_FAR to FAR or further out in clearer air, takes it from there). Only one that can't get
 * away (hemmed in by trees) or is still running after FLEE_MAX fades, and slowly.
 */
const FLEE_FADE = 2.5;
const FLEE_MAX = 14;
/** Fleeing, at least this much headway every few seconds, or it is hemmed in. */
const FLEE_HEADWAY = 8;

/** How far ahead a deer looks for a way between the trees. */
const LOOK = 5;
/** The berth a deer gives a trunk when looking for a way through. */
const berth = (c: Collider) => coreRadius(c) + 0.05;

function ear(x: number, y: number, z: number, lean: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 6, 4);
  g.scale(0.025, 0.09, 0.045);
  g.rotateZ(lean);
  g.translate(x, y, z);
  return g;
}

interface DeerShapes {
  body: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  headStag: THREE.BufferGeometry;
  upperFront: THREE.BufferGeometry;
  upperHind: THREE.BufferGeometry;
  lowerFront: THREE.BufferGeometry;
  lowerHind: THREE.BufferGeometry;
}

/** Knee or hock to hoof: a slim cannon, a knobbly fetlock, a short pastern and a dark hoof. */
function lowerLeg(joint: number, reach: number): THREE.BufferGeometry {
  const leg = 0.27;
  const hoof = 0.1;
  const z = (t: number) => joint + (reach - joint) * t;
  return loft(
    "y",
    [
      [joint, 0.02, 0.042, 0.055, leg],
      [joint * 0.5, -0.05, 0.035, 0.045, leg],
      [z(0.5), -0.2, 0.03, 0.038, leg],
      [z(0.85), -LOWER + 0.12, 0.029, 0.036, leg],
      [z(1) - 0.005, -LOWER + 0.08, 0.035, 0.044, leg],
      [z(1) + 0.012, -LOWER + 0.045, 0.031, 0.036, leg],
      [z(1) + 0.025, -LOWER + 0.03, 0.036, 0.046, hoof],
      [z(1) + 0.035, -LOWER, 0.038, 0.055, hoof]
    ],
    0.3
  );
}

/** Neck and head share a pivot at the base of the neck; local +Z is forward. */
const NECK_BASE = new THREE.Vector3(0, 1.16, 0.52);

/** Where the hock sits under a hind leg's joint: the gaskin slopes back to it. */
const HOCK_BACK = 0.13;

function buildShapes(): DeerShapes {
  const coat = 0.3;
  // Deep and narrow through the chest, the belly drawing up into the flank, and round
  // haunches behind: a deer's torso, not a barrel. Rings run from the breast to the rump.
  const torso = loft(
    "z",
    [
      [0.68, 1.1, 0.07, 0.12, coat],
      [0.6, 1.06, 0.14, 0.24, coat],
      [0.45, 1.04, 0.18, 0.28, coat],
      [0.25, 1.06, 0.2, 0.27, coat],
      [0.02, 1.1, 0.21, 0.23, coat],
      [-0.2, 1.13, 0.19, 0.2, coat],
      [-0.38, 1.13, 0.2, 0.23, coat],
      [-0.55, 1.13, 0.18, 0.21, coat],
      [-0.66, 1.14, 0.11, 0.14, coat],
      [-0.7, 1.15, 0.03, 0.04, coat]
    ],
    0.9,
    9
  );
  const body = mergeGeometries([
    torso,
    // Shoulder blades and hams, filling out where the legs meet the body.
    paint(ellipsoid(0.07, 0.2, 0.12, 0.11, 1.0, 0.42, 0.25), coat, 0.6),
    paint(ellipsoid(0.07, 0.2, 0.12, -0.11, 1.0, 0.42, 0.25), coat, 0.6),
    paint(ellipsoid(0.1, 0.24, 0.18, 0.115, 1.04, -0.43, -0.25), coat, 0.6),
    paint(ellipsoid(0.1, 0.24, 0.18, -0.115, 1.04, -0.43, -0.25), coat, 0.6),
    // The pale rump patch is what stays visible longest as a deer walks off into the snow.
    paint(ellipsoid(0.12, 0.15, 0.05, 0, 1.08, -0.66), 0.78),
    paint(ellipsoid(0.05, 0.1, 0.04, 0, 1.2, -0.72, 0.3), 0.7)
  ])!;

  const tilt = 0.62;
  const neckTop = new THREE.Vector3(0, Math.cos(tilt) * 0.52, Math.sin(tilt) * 0.52);
  const headParts = [
    paint(rod(new THREE.Vector3(0, -0.05, -0.04), neckTop, 0.13, 0.085), coat, 0.6),
    paint(ellipsoid(0.085, 0.095, 0.17, 0, neckTop.y + 0.02, neckTop.z + 0.1, 0.55), coat, 0.5),
    paint(ellipsoid(0.05, 0.05, 0.08, 0, neckTop.y - 0.07, neckTop.z + 0.22, 0.6), 0.18),
    paint(ear(0.09, neckTop.y + 0.14, neckTop.z + 0.02, -0.5), coat),
    paint(ear(-0.09, neckTop.y + 0.14, neckTop.z + 0.02, 0.5), coat)
  ];
  const head = mergeGeometries(headParts)!;

  // A modest set of antlers: a beam per side with a few tines.
  const antlers: THREE.BufferGeometry[] = [];
  const crown = new THREE.Vector3(0, neckTop.y + 0.1, neckTop.z + 0.03);
  for (const side of [1, -1]) {
    const base = crown.clone().add(new THREE.Vector3(0.05 * side, 0, 0));
    const mid = base.clone().add(new THREE.Vector3(0.17 * side, 0.22, -0.1));
    const tip = mid.clone().add(new THREE.Vector3(0.06 * side, 0.24, 0.02));
    antlers.push(rod(base, mid, 0.022, 0.016), rod(mid, tip, 0.016, 0.006));
    const brow = base.clone().add(new THREE.Vector3(0.05 * side, 0.06, 0.01));
    antlers.push(rod(brow, brow.clone().add(new THREE.Vector3(0.02 * side, 0.08, 0.12)), 0.012, 0.004));
    antlers.push(rod(mid, mid.clone().add(new THREE.Vector3(0.02 * side, 0.12, 0.13)), 0.012, 0.004));
  }
  const headStag = mergeGeometries([...headParts, ...antlers.map((g) => paint(g, 0.22, 0.6))])!;

  return {
    body,
    head,
    headStag,
    // Forearm: muscled at the top, slimming to the knee; wider front to back than side to side.
    upperFront: loft(
      "y",
      [
        [0, 0.08, 0.075, 0.1, coat],
        [0.005, -0.12, 0.07, 0.09, coat],
        [0, -0.3, 0.045, 0.058, coat],
        [0, -UPPER + 0.03, 0.04, 0.05, coat],
        [0, -UPPER - 0.02, 0.04, 0.05, coat]
      ],
      0.5
    ),
    // Thigh and gaskin, sloping back to the hock.
    upperHind: loft(
      "y",
      [
        [0.05, 0.1, 0.09, 0.17, coat],
        [0.02, -0.1, 0.075, 0.13, coat],
        [-0.06, -0.28, 0.05, 0.075, coat],
        [-HOCK_BACK, -UPPER + 0.02, 0.04, 0.055, coat],
        [-HOCK_BACK - 0.005, -UPPER - 0.02, 0.035, 0.05, coat]
      ],
      0.5
    ),
    lowerFront: lowerLeg(0, 0.03),
    // The point of the hock sticks out behind, and the cannon angles forward under the body.
    lowerHind: lowerLeg(-0.035, HOCK_BACK - 0.06)
  };
}

/** A deer in winter: warm brown, the legs, nose and antlers darker and duller, the rump and belly buff. */
const DEER_COAT: CoatPalette = {
  dark: 0x3b3431,
  mid: 0x7c5a3d,
  pale: 0xd9c5a3,
  stops: [0.2, 0.3, 0.7],
  under: 0xb79d7e
};

interface Leg {
  upper: THREE.Mesh;
  lower: THREE.Mesh;
  front: boolean;
  /** Phase offsets within the stride for the walk and the bound. */
  walkOff: number;
  boundOff: number;
}

type State = "walk" | "pause" | "flee";

class Deer {
  readonly root = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly material: THREE.MeshStandardMaterial;
  readonly veil = { value: 1 };
  heading = 0;
  speed = 0;
  state: State = "walk";
  active = false;
  /** Fading out; hidden once fully dissolved, or once it has been off screen UNSEEN_FOR seconds. */
  vanishing = false;
  /** Done with its crossing and walking off: hidden once it has been off screen UNSEEN_FOR seconds. */
  leaving = false;
  /** Seconds since it started leaving. */
  leftFor = 0;
  /** Seconds it has been off screen. */
  unseen = 0;
  /** Leaving, and past the end of its route. */
  private offRoute = false;
  /** Made up its mind to run after looking at the walker. */
  spooked = false;
  private fade = 0;
  private fadeTime = FLEE_FADE;
  private fleeFor = 0;
  private neck = new THREE.Group();
  private head: THREE.Mesh;
  private legs: Leg[] = [];
  private phase = Math.random();
  /** How fast it actually gets anywhere, which the legs go by (trees can hold it back). */
  private stepSpeed = 0;
  private pauseLeft = 0;
  private boltAfterPause = false;
  private alert = 0;
  private want = 0;
  private free = LOOK;
  private steerIn = 0;
  /** Turning points ahead, as x, z pairs; the last one is the end of the crossing. */
  readonly route: number[] = [];
  private routeAt = 0;
  private checkIn = 0;
  /** Seconds of the current check window it meant to walk on (not held up behind another deer). */
  private pushing = 0;
  private readonly checkFrom = new THREE.Vector2();

  constructor(private shapes: DeerShapes) {
    const material = (this.material = createCoatMaterial(this.veil, DEER_COAT, DEER_WARMTH));
    this.root.rotation.order = "YXZ";
    this.root.add(new THREE.Mesh(shapes.body, material));
    this.neck.position.copy(NECK_BASE);
    this.head = new THREE.Mesh(shapes.head, material);
    this.neck.add(this.head);
    this.root.add(this.neck);
    const spots: [number, number, boolean, number, number][] = [
      // x, z, front, walk offset (lateral-sequence walk), bound offset
      [0.13, 0.42, true, 0.25, 0],
      [-0.13, 0.42, true, 0.75, 0.08],
      [0.13, -0.42, false, 0.5, 0.55],
      [-0.13, -0.42, false, 0, 0.62]
    ];
    for (const [x, z, front, walkOff, boundOff] of spots) {
      const upper = new THREE.Mesh(front ? shapes.upperFront : shapes.upperHind, material);
      upper.position.set(x, HIP_Y, z);
      const lower = new THREE.Mesh(front ? shapes.lowerFront : shapes.lowerHind, material);
      lower.position.set(0, -UPPER, front ? 0 : -HOCK_BACK);
      upper.add(lower);
      this.root.add(upper);
      this.legs.push({ upper, lower, front, walkOff, boundOff });
    }
    this.root.visible = false;
  }

  setStag(stag: boolean): void {
    this.head.geometry = stag ? this.shapes.headStag : this.shapes.head;
  }

  spawn(x: number, z: number, heading: number, stag: boolean, route: number[]): void {
    this.position.set(x, 0, z);
    this.heading = heading;
    this.want = heading;
    this.steerIn = 0;
    this.speed = WALK_SPEED;
    this.stepSpeed = WALK_SPEED;
    this.state = "walk";
    this.pauseLeft = 0;
    this.alert = 0;
    this.active = true;
    this.vanishing = false;
    this.leaving = false;
    this.leftFor = 0;
    this.unseen = 0;
    this.offRoute = false;
    this.spooked = false;
    // There at once: it starts out of sight (or before the scene has faded up).
    this.fade = 0;
    this.veil.value = 0;
    this.root.visible = false;
    this.setStag(stag);
    this.route.length = 0;
    this.route.push(...route);
    this.routeAt = 0;
    this.checkFrom.set(x, z);
    this.checkIn = 4;
    this.pushing = 0;
  }

  /** At or near the end of its route. */
  get arrived(): boolean {
    const n = this.route.length;
    return n === 0 || (this.routeAt >= n - 2 && Math.hypot(this.route[n - 2] - this.position.x, this.route[n - 1] - this.position.z) < 3);
  }

  /** Share of the route behind it, by turning points. */
  get progress(): number {
    return this.route.length === 0 ? 1 : this.routeAt / this.route.length;
  }

  /** The next turning point, moving on once the deer is close to the current one. */
  waypoint(out: THREE.Vector2, walker: THREE.Vector3): THREE.Vector2 {
    const r = this.route;
    const p = this.position;
    if (this.leaving && (this.offRoute || this.arrived)) {
      this.offRoute = true;
      // Past the end of its route: on round the walker the way it was going, edging further out.
      const ox = p.x - walker.x;
      const oz = p.z - walker.z;
      const d = Math.hypot(ox, oz) || 1;
      const ux = ox / d;
      const uz = oz / d;
      const turn = Math.sin(this.heading) * uz - Math.cos(this.heading) * ux >= 0 ? 1 : -1;
      return out.set(p.x + (uz * turn * 0.8 + ux * 0.6) * 5, p.z + (-ux * turn * 0.8 + uz * 0.6) * 5);
    }
    if (r.length === 0) return out.set(p.x + Math.sin(this.heading), p.z + Math.cos(this.heading));
    const toWalker = Math.atan2(walker.x - p.x, walker.z - p.z);
    while (this.routeAt < r.length - 2) {
      const dx = r[this.routeAt] - p.x;
      const dz = r[this.routeAt + 1] - p.z;
      const d = Math.hypot(dx, dz);
      // Reached, or one it may not head for (the walker has moved): on to the next.
      if (d < 1.6 || (d < 5 && Math.cos(Math.atan2(dx, dz) - toWalker) > WALK_APPROACH)) this.routeAt += 2;
      else break;
    }
    return out.set(r[this.routeAt], r[this.routeAt + 1]);
  }

  hide(): void {
    this.active = false;
    this.root.visible = false;
    this.veil.value = 1;
  }

  vanish(seconds: number): void {
    if (this.vanishing) {
      this.fadeTime = Math.min(this.fadeTime, seconds);
      return;
    }
    this.vanishing = true;
    this.fadeTime = seconds;
  }

  /** Walks off; the herd hides it once it has been off screen UNSEEN_FOR seconds. */
  leave(): void {
    this.leaving = true;
  }

  /** Holds still for a few seconds, head up and turned towards the walker. */
  pause(seconds: number, bolt: boolean): void {
    if (this.state !== "walk") return;
    this.state = "pause";
    this.pauseLeft = seconds;
    this.boltAfterPause = bolt;
  }

  /** Runs straight away from the walker, until out of sight or lost in the fog. */
  flee(rand: () => number): void {
    if (this.state === "flee") return;
    this.state = "flee";
    this.fleeFor = FLEE_MAX + rand() * 2;
    // Headway is measured from here, not from wherever the last walking check left off.
    this.checkFrom.set(this.position.x, this.position.z);
    this.checkIn = 3;
  }

  /**
   * Samples headings around the direction of the target and keeps the one that
   * best trades open ground ahead against straying from the way, among those
   * that don't point towards the walker by more than `limit`.
   */
  private chooseHeading(target: number, colliders: Collider[], toWalker: number, limit: number): void {
    let best = -Infinity;
    const current = wrap(this.want - target);
    for (const off of HEADINGS) {
      const h = target + off;
      if (Math.cos(h - toWalker) > limit) continue;
      const free = freeDistance(this.position, Math.sin(h), Math.cos(h), colliders, LOOK, berth);
      const score = Math.min(free, LOOK) / LOOK + Math.cos(off) * 0.55 - (free < 1.2 ? 2 : 0) - Math.abs(wrap(off - current)) * 0.08;
      if (score > best) {
        best = score;
        this.want = h;
        this.free = free;
      }
    }
    if (best === -Infinity) {
      // Nothing allowed near the target: straight away from the walker.
      this.want = toWalker + Math.PI;
      this.free = LOOK;
    }
  }

  update(
    dt: number,
    targetX: number,
    targetZ: number,
    targetSpeed: number,
    walker: THREE.Vector3,
    height: HeightFn,
    world: World,
    colliders: Collider[],
    veilFar: number,
    veilGone: number
  ): void {
    const p = this.position;
    const toWalker = Math.atan2(walker.x - p.x, walker.z - p.z);
    const dist = Math.hypot(walker.x - p.x, walker.z - p.z);

    if (this.state === "pause") {
      this.pauseLeft -= dt;
      targetSpeed = 0;
      if (this.pauseLeft <= 0) {
        this.state = "walk";
        if (this.boltAfterPause) this.spooked = true;
        // Setting off again from a standstill is not being stuck.
        this.checkFrom.set(p.x, p.z);
        this.checkIn = 4;
        this.pushing = 0;
      }
    }
    const fleeing = this.state === "flee";
    if (fleeing) {
      targetSpeed = FLEE_SPEED;
      this.fleeFor -= dt;
      if (this.fleeFor <= 0) this.vanish(FLEE_FADE);
    }
    const limit = fleeing ? FLEE_APPROACH : WALK_APPROACH;

    // Steer towards the target (or straight away, when fleeing) along whichever nearby direction is open.
    world.collidersNear(p.x, p.z, colliders);
    this.steerIn -= dt;
    if (this.steerIn <= 0 || (fleeing && Math.cos(this.want - toWalker) > limit)) {
      this.steerIn = 0.15;
      const target = fleeing ? toWalker + Math.PI : Math.atan2(targetX - p.x, targetZ - p.z);
      this.chooseHeading(target, colliders, toWalker, limit);
    }
    const maxTurn = (fleeing ? 3.2 : 1.6) * dt;
    const rel = wrap(this.heading - toWalker);
    let turn = wrap(this.want - this.heading);
    if (Math.cos(rel) > WALK_APPROACH) {
      // Facing the walker (it moved, or the deer is wheeling round to run): turn away the short way.
      turn = rel >= 0 ? Math.PI : -Math.PI;
    } else if (Math.sign(rel) !== Math.sign(rel + turn) && Math.abs(rel + turn) < Math.PI) {
      // The short way round would swing through the walker's direction: go the long way.
      turn -= Math.sign(turn) * TAU;
    }
    this.heading = wrap(this.heading + THREE.MathUtils.clamp(turn, -maxTurn, maxTurn));

    // Slower while squeezing past something or turning a long way round, and no
    // pace at all while still facing the walker.
    const facing = Math.cos(this.heading - toWalker);
    const away = THREE.MathUtils.clamp((WALK_APPROACH + 0.25 - facing) / 0.25, 0, 1);
    const ease = Math.min(1, this.free / 2) * (0.35 + 0.65 * Math.max(0, Math.cos(turn)));
    let goal = targetSpeed * (fleeing ? Math.max(0.5, ease) : ease) * away;
    // Edging in round a tree: slow enough that the legs match the capped motion below.
    if (!fleeing && facing > 0) goal = Math.min(goal, MAX_CLOSING_WALK / facing);
    const accel = goal > this.speed ? (fleeing ? 7 : 1.2) : fleeing ? 8 : 2.5;
    this.speed += THREE.MathUtils.clamp(goal - this.speed, -accel * dt, accel * dt);
    const x0 = p.x;
    const z0 = p.z;
    p.x += Math.sin(this.heading) * this.speed * dt;
    p.z += Math.cos(this.heading) * this.speed * dt;
    // Never end up inside a trunk (twice over, for trees standing close together).
    for (let pass = 0; pass < 2; pass++) {
      for (const c of colliders) {
        const ox = p.x - c.x;
        const oz = p.z - c.z;
        const r = coreRadius(c);
        const d2 = ox * ox + oz * oz;
        if (d2 < r * r && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          p.x = c.x + (ox / d) * r;
          p.z = c.z + (oz / d) * r;
        }
      }
    }
    // Whatever the steering or a trunk did, the deer itself never closes in on the walker.
    {
      const ux = (walker.x - x0) / (dist || 1);
      const uz = (walker.z - z0) / (dist || 1);
      const closing = (p.x - x0) * ux + (p.z - z0) * uz;
      const cap = (fleeing ? 0 : MAX_CLOSING_WALK) * dt;
      if (closing > cap) {
        p.x -= (closing - cap) * ux;
        p.z -= (closing - cap) * uz;
        // That put it back into a trunk: rather stand still this frame.
        for (const c of colliders) {
          const r = coreRadius(c) - 0.05;
          if ((p.x - c.x) ** 2 + (p.z - c.z) ** 2 < r * r) {
            p.x = x0;
            p.z = z0;
            break;
          }
        }
      }
    }

    // Pinned against trunks it would only run on the spot: the legs follow the actual movement.
    const actual = dt > 0 ? Math.hypot(p.x - x0, p.z - z0) / dt : this.stepSpeed;
    this.stepSpeed += (Math.min(this.speed, actual) - this.stepSpeed) * (1 - Math.exp(-dt * 6));

    // No headway for a while although it means to walk: rather than look for a
    // way that might lead towards the walker, it takes fright and runs off.
    // Only a deer that meant to walk on all along counts: a follower waiting behind one that
    // stopped, then getting going again, is not stuck.
    this.checkIn -= dt;
    if (this.state === "walk" && targetSpeed > 0.5) this.pushing += dt;
    if (this.checkIn <= 0) {
      const moved = Math.hypot(p.x - this.checkFrom.x, p.z - this.checkFrom.y);
      if (this.state === "walk" && this.pushing > 3.6 && moved < 1.5) this.spooked = true;
      this.pushing = 0;
      // Fleeing but hemmed in by trees: it can't run out of sight, so it slips away into the snow.
      if (fleeing && moved < FLEE_HEADWAY) this.vanish(FLEE_FADE);
      this.checkFrom.set(p.x, p.z);
      this.checkIn = fleeing ? 3 : 4;
    }

    // Veil: only a deer that can't get out of sight (hemmed in by trees) is faded out; besides
    // that, it closes regardless as the walker nears, and far out in the fog.
    if (this.vanishing) this.fade = Math.min(1, this.fade + dt / this.fadeTime);
    if (this.leaving) this.leftFor += dt;
    const near = 1 - THREE.MathUtils.smoothstep(dist, VEIL_GONE, VEIL_NEAR);
    const far = THREE.MathUtils.smoothstep(dist, veilFar, veilGone);
    this.veil.value = Math.max(this.fade, near, far);
    this.root.visible = this.veil.value < 0.999;

    // Gait: a four-beat walk blending into a bounding run.
    const bound = THREE.MathUtils.smoothstep(this.stepSpeed, 2.6, 4.2);
    // Longer leaps rather than faster legs at a full run (about 2.3 bounds a second).
    const stride = THREE.MathUtils.lerp(1.35, 4.1, bound);
    this.phase = (this.phase + (this.stepSpeed / stride) * dt) % 1;
    const move = Math.min(1, this.stepSpeed / 0.6);
    for (const leg of this.legs) {
      const off = THREE.MathUtils.lerp(leg.walkOff, leg.boundOff, bound);
      const a = TAU * (this.phase + off);
      const swing = THREE.MathUtils.lerp(0.34, 0.75, bound) * move;
      const lift = Math.max(0, Math.cos(a)) * move;
      leg.upper.rotation.x = -Math.sin(a) * swing + (leg.front ? 0 : -0.05);
      leg.lower.rotation.x = (leg.front ? 1 : 0.7) * lift * THREE.MathUtils.lerp(0.75, 1.3, bound);
    }

    // Body: follows the ground, pitched along the slope, rising and falling with each stride.
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const hf = height(p.x + fx * 0.6, p.z + fz * 0.6);
    const hb = height(p.x - fx * 0.6, p.z - fz * 0.6);
    const ground = (hf + hb) / 2;
    const gaitBob = Math.sin(this.phase * TAU * 2) * 0.018 * move * (1 - bound);
    const leap = Math.abs(Math.sin(this.phase * TAU)) * 0.22 * bound;
    p.y = ground - 0.04 + gaitBob + leap;
    const rock = Math.sin(this.phase * TAU) * 0.12 * bound;
    this.root.position.copy(p);
    this.root.rotation.set(-Math.atan2(hf - hb, 1.2) * 0.8 + rock, this.heading, 0);

    // Head: nods while walking, comes up and turns to the walker when wary.
    const wary = this.state === "pause" ? 1 : 0;
    this.alert += (wary - this.alert) * (1 - Math.exp(-dt * 3));
    const look = THREE.MathUtils.clamp(wrap(toWalker - this.heading), -1.3, 1.3);
    const nod = Math.sin(this.phase * TAU * 2 + 0.6) * 0.06 * move * (1 - bound);
    this.neck.rotation.set(nod - this.alert * 0.3 + bound * 0.35, look * this.alert, 0);
  }
}

/**
 * Now and then a deer, or a few in single file, crosses the forest in the fog:
 * walking in from out of sight at the edge of the view and out of it again,
 * never appearing or vanishing where the walker can see it.
 */
export class Herd {
  readonly group = new THREE.Group();
  private shapes = buildShapes();
  private deer: Deer[] = [];
  private colliders: Collider[] = [];
  private planner: ArcPlanner;
  private time = 0;
  private nextAt: number;
  private paused = false;
  private age = 0;
  private target = new THREE.Vector2();
  private route: number[] = [];
  /** The opening crossing hasn't started yet. */
  private opening = true;
  /** Arcs tried in a row without finding a way through the trees. */
  private tries = 0;
  private firstCrossing = false;
  /** Something is about that deer keep well away from: those here make off, and no more come. */
  private scared = false;

  constructor(
    private height: HeightFn,
    private world: World,
    private sight: Sight,
    private rand: () => number = Math.random
  ) {
    this.planner = new ArcPlanner(world);
    for (let i = 0; i < 3; i++) {
      const d = new Deer(this.shapes);
      this.deer.push(d);
      this.group.add(d.root);
    }
    // The first crossing starts with the scene, so the forest opens with a deer in the distance.
    this.nextAt = 0;
  }

  get active(): boolean {
    return this.deer.some((d) => d.active);
  }

  /**
   * While loading: every deer shown where it stands (dissolved to nothing), one with
   * antlers, so the frame drawn then sends all their shapes to the graphics card.
   * reset() puts them away again.
   */
  showForWarmUp(): void {
    this.deer.forEach((d, i) => {
      d.setStag(i === 1);
      d.root.visible = true;
    });
  }

  /** The deer here take fright and run off into the fog, and no more come until reset(). */
  scatter(): void {
    if (this.scared) return;
    this.scared = true;
    for (const d of this.deer) if (d.active) d.flee(this.rand);
  }

  /** As on a first visit: no deer about, and the opening crossing right in front from the first frame. */
  reset(): void {
    for (const d of this.deer) d.hide();
    this.scared = false;
    this.time = 0;
    this.nextAt = 0;
    this.opening = true;
    this.tries = 0;
    this.firstCrossing = false;
    this.paused = false;
    this.age = 0;
  }

  /**
   * Starts a crossing now (also handy from the console): in from just out of sight at
   * one edge of the view, or, for the opening one, right in front while the scene is dark.
   */
  spawn(walker: THREE.Vector3, yaw: number): void {
    const r = this.rand;
    // Too late for the opening one to be there from the start: it comes in like any other.
    if (this.opening && this.time > OPENING_WINDOW) this.opening = false;
    // In the (sin, cos) heading convention used here, the walker faces this way.
    const facing = Math.atan2(-Math.sin(yaw), -Math.cos(yaw));
    const side = r() < 0.5 ? 1 : -1;
    const radius = RING_NEAR + r() * (RING_FAR - RING_NEAR);
    let from: number;
    let to: number;
    if (this.opening) {
      // The opening crossing is there from the first frame (the scene fades up from black), right in front.
      const centre = facing + (r() - 0.5) * 0.5;
      const half = 0.55 + r() * 0.25;
      from = centre - side * half;
      to = centre + side * half;
    } else {
      // From just out of sight at one edge of the view across most of it: the deer walks into view.
      const edge = this.sight.halfView + EDGE + VIEW_PAD / radius;
      from = facing - side * (edge + r() * 0.15);
      to = from + side * edge * (1.5 + r() * 0.5);
    }
    const half = Math.abs(to - from) / 2;

    // A route that only ever goes along the arc or outwards, long enough to be a crossing
    // (one walled off by trees after a few metres would be over before it could be seen).
    const planned = this.planner.plan({ x: walker.x, z: walker.z, radius, drift: RING_DRIFT, from, to }, this.route);
    const ok =
      planned &&
      this.route.length / 2 >= MIN_COVER * 2 * half * radius &&
      this.seen(walker) &&
      (this.opening || !this.inView(this.route[0], this.route[1]));
    if (!ok) {
      // Trees or a hill in the way: another arc next frame, a few times (many more for the opening one), then wait a little.
      const retry = ++this.tries < (this.opening ? 40 : 8);
      if (!retry) this.tries = 0;
      this.nextAt = this.time + (retry ? 0 : 5);
      return;
    }
    this.tries = 0;
    this.firstCrossing = this.opening;
    this.opening = false;

    const roll = r();
    const count = roll < 0.55 ? 1 : roll < 0.85 ? 2 : 3;
    for (let i = 0; i < count; i++) {
      // Followers start a few metres further back along the arc, a little further out if a tree is in the way.
      const a = from - (side * i * (3.2 + r() * 1.5)) / radius;
      let x = this.route[0];
      let z = this.route[1];
      if (i > 0) {
        for (let rr = radius; rr < radius + 6; rr += 0.5) {
          x = walker.x + Math.sin(a) * rr;
          z = walker.z + Math.cos(a) * rr;
          if (!this.inCore(x, z)) break;
        }
      }
      const heading = Math.atan2(Math.cos(a) * side, -Math.sin(a) * side);
      this.deer[i].spawn(x, z, heading, i === 0 && r() < 0.45, this.route);
    }
    this.paused = false;
    this.age = 0;
  }

  /** Call once the sight is up to date for this frame. */
  update(dt: number, walker: THREE.Vector3, walkerVelocity: THREE.Vector3, yaw: number): void {
    this.time += dt;
    if (!this.active) {
      if (!this.scared && this.time >= this.nextAt) {
        // Someone striding through the forest would only ever see deer running off: wait for a calmer moment.
        if (Math.hypot(walkerVelocity.x, walkerVelocity.z) > 3) this.nextAt = this.time + 4;
        else this.spawn(walker, yaw);
      }
      return;
    }
    this.age += dt;
    const lead = this.deer[0];
    // In clearer air the far veil stands further out, where the fog itself hides a deer.
    const veilFar = Math.max(VEIL_FAR, this.sight.hiddenBeyond(FAR_DIM));
    const veilGone = Math.max(FAR, this.sight.hiddenBeyond(FAR_DARK));

    // Alarm: one deer startled is the whole group running, away from the walker.
    if (!this.deer.some((d) => d.active && d.state === "flee")) {
      const startled = this.deer.some((d) => {
        if (!d.active) return false;
        if (d.spooked) return true;
        const dx = d.position.x - walker.x;
        const dz = d.position.z - walker.z;
        const dist = Math.hypot(dx, dz);
        // How fast the walker is coming at it (dx, dz point from the walker to the deer).
        const closing = (walkerVelocity.x * dx + walkerVelocity.z * dz) / (dist || 1);
        // Walking off and still being followed: it has had enough.
        if (d.leaving && (d.leftFor > LEAVE_MAX || (dist < VEIL_FAR && closing > FOLLOWED))) return true;
        return dist < ALARM || (dist < SIGHT && closing > CLOSING);
      });
      if (startled) for (const d of this.deer) if (d.active) d.flee(this.rand);
    }
    // A fleeing deer outruns anyone, out into the fog; one hemmed in by trees is caught by its
    // headway check, and the near veil is the hard limit whatever happens.

    // Halfway across, the leader sometimes stops to look at the walker, and may then bolt.
    if (!this.paused && lead.active && lead.state === "walk" && lead.progress >= 0.45) {
      this.paused = true;
      // The opening one always stops, for longer, and walks on calmly.
      if (this.firstCrossing) lead.pause(4 + this.rand() * 3, false);
      else if (this.rand() < 0.5) lead.pause(2 + this.rand() * 3, this.rand() < 0.5);
    }

    for (let i = 0; i < this.deer.length; i++) {
      const d = this.deer[i];
      if (!d.active) continue;
      const t = d.waypoint(this.target, walker);
      let speed = d.leaving ? LEAVE_SPEED : WALK_SPEED;
      if (i > 0 && this.deer[i - 1].active && d.state === "walk" && !d.leaving) {
        // Followers keep a few metres behind the one in front, stopping when it stops.
        const ahead = this.deer[i - 1];
        const gap = Math.hypot(ahead.position.x - d.position.x, ahead.position.z - d.position.z);
        speed = THREE.MathUtils.clamp((gap - 3) * 1.2, 0, WALK_SPEED * 1.4);
      }
      d.update(dt, t.x, t.y, speed, walker, this.height, this.world, this.colliders, veilFar, veilGone);

      // The end of the crossing: it walks on until out of sight (a fleeing deer runs until then).
      if (d.state !== "flee" && (d.arrived || this.age > 90)) d.leave();
      const dist = Math.hypot(d.position.x - walker.x, d.position.z - walker.z);
      const going = d.leaving || d.vanishing || d.state === "flee";
      d.unseen = this.inView(d.position.x, d.position.z) ? 0 : d.unseen + dt;
      if (going && d.unseen >= UNSEEN_FOR) d.hide();
      else if (d.veil.value >= 0.999 && (d.vanishing || dist <= VEIL_GONE || dist >= veilGone)) d.hide();
    }

    if (!this.active) this.nextAt = this.time + 30 + this.rand() * 60;
  }

  /**
   * Whether the planned crossing can be seen: no rise in the snow between the
   * walker's eyes and the deer halfway along (where the leader stops to look).
   * The opening crossing must also be clear of trees, at its start and halfway,
   * unless arc after arc has failed (a hollow ringed by trees): then any will do.
   */
  private seen(walker: THREE.Vector3): boolean {
    const r = this.route;
    const mid = Math.floor(r.length / 4) * 2;
    if (!this.inSight(walker, r[mid], r[mid + 1], false)) return false;
    if (!this.opening || this.tries > 20) return true;
    return this.inSight(walker, r[mid], r[mid + 1], true) && this.inSight(walker, r[0], r[1], true);
  }

  private inSight(walker: THREE.Vector3, x: number, z: number, trees: boolean): boolean {
    // Aim at the back: the top of the body, about a metre up.
    if (!this.sight.overSnow(walker, x, z, 1.1, 24)) return false;
    if (!trees) return true;
    const dx = x - walker.x;
    const dz = z - walker.z;
    const len2 = dx * dx + dz * dz;
    const cs = this.world.collidersIn(Math.min(walker.x, x) - 4, Math.min(walker.z, z) - 4, Math.max(walker.x, x) + 4, Math.max(walker.z, z) + 4, this.colliders);
    for (const c of cs) {
      // A deer shows over a fallen trunk.
      if (c.log && c.walk <= 0) continue;
      const t = ((c.x - walker.x) * dx + (c.z - walker.z) * dz) / len2;
      if (t < 0.02 || t > 0.98) continue;
      const ox = walker.x + dx * t - c.x;
      const oz = walker.z + dz * t - c.z;
      const skirt = c.r * 0.75;
      if (ox * ox + oz * oz < skirt * skirt) return false;
    }
    return true;
  }

  /** Whether any of a deer standing here could be on screen. */
  private inView(x: number, z: number): boolean {
    return this.sight.inView(x, z, 0.9, VIEW_PAD);
  }

  private inCore(x: number, z: number): boolean {
    for (const c of this.world.collidersNear(x, z, this.colliders)) {
      const r = coreRadius(c) + 0.2;
      if ((x - c.x) ** 2 + (z - c.z) ** 2 < r * r) return true;
    }
    return false;
  }

  dispose(): void {
    const s = this.shapes;
    for (const g of [s.body, s.head, s.headStag, s.upperFront, s.upperHind, s.lowerFront, s.lowerHind]) g.dispose();
    for (const d of this.deer) d.material.dispose();
  }
}
