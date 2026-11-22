import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { TAU, wrap } from "../lib/math";
import type { Collider } from "../world/collider";
import { heightGradient, type HeightFn } from "../world/terrain";
import type { World } from "../world/world";
import { createCoatMaterial, ellipsoid, loft, paint, rod, warm, type CoatPalette, type Ring } from "./creature";
import { HEADINGS, freeDistance, slopePace } from "./steer";

/**
 * Grays as painted, and how warm each part shows to the eyes that see heat (a share of a
 * face's warmth): the sheepskin and the felt boots keep the heat in and show cool, the
 * scarf and the hat a little less so, the bare face burns.
 */
const SHEEPSKIN = 0.4;
const FLEECE = 0.72;
const SCARF = 0.5;
const HAT = 0.28;
const FELT = 0.3;
const CLOTH = 0.24;
const SKIN = 0.62;
const BEARD = 0.34;
const HEAT_COAT = 0.2;
const HEAT_FLEECE = 0.26;
const HEAT_SCARF = 0.34;
const HEAT_HAT = 0.22;
const HEAT_BOOTS = 0.12;
const HEAT_CLOTH = 0.28;
const HEAT_MITTEN = 0.32;
const HEAT_FACE = 1;
const HEAT_NOSE = 0.78;
const HEAT_BEARD = 0.6;
/** In colour (he is never seen in it, but the material wants one): a brown sheepskin, a cream fleece. */
const COAT: CoatPalette = {
  dark: 0x2a2018,
  mid: 0x6b4a2e,
  pale: 0xd8ccb4,
  stops: [0.2, 0.42, 0.72],
  under: 0x5a4636
};

const HIP_Y = 0.94;
const THIGH = 0.44;
const SHIN = 0.44;
const UPPER_ARM = 0.3;
const FOREARM = 0.28;
/** An easy walk home through the forest, and running for his life. */
export const MAN_WALK = 1.25;
export const MAN_RUN = 4.6;
/** Going in through the door takes him this long, seconds. */
export const MAN_ENTER = 0.9;
/** Getting up to a run, m/s each second. */
const ACCEL = 3.2;
const BODY = 0.3;
const LOOK = 4.5;

type State = "hidden" | "walk" | "startle" | "run" | "enter" | "held";

const berth = (c: Collider) => (c.walk > 0 ? c.walk + BODY : 0);

const lerp = THREE.MathUtils.lerp;

const limb = (rings: Ring[]) => loft("y", rings, 0.4, 8);

interface ManShapes {
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  forearm: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
}

function buildShapes(): ManShapes {
  const s = SHEEPSKIN;
  // A sheepskin coat to the knees (origin at the hips), the fleece turned out at the
  // collar and the hem, belted at the waist; a scarf wound round the neck, one end hanging.
  const torso = mergeGeometries([
    warm(
      loft(
        "y",
        [
          [0, 0.6, 0.12, 0.11, s],
          [0, 0.52, 0.25, 0.16, s],
          [0.01, 0.42, 0.25, 0.16, s],
          [0.02, 0.24, 0.23, 0.16, s],
          [0.02, 0.06, 0.21, 0.15, s],
          [0.01, -0.08, 0.23, 0.17, s],
          [0, -0.3, 0.27, 0.2, s],
          [0, -0.38, 0.28, 0.21, FLEECE * 0.9],
          [0, -0.41, 0.2, 0.15, FLEECE * 0.8]
        ],
        0.5,
        12
      ),
      HEAT_COAT
    ),
    // The fleece collar, turned up round the scarf.
    warm(paint(ellipsoid(0.2, 0.07, 0.15, 0, 0.53, 0.0), FLEECE, 0.3), HEAT_FLEECE),
    // A dark belt.
    warm(paint(ellipsoid(0.222, 0.035, 0.158, 0, 0.06, 0.02), 0.12), HEAT_COAT),
    // The scarf, and its end hanging down the front.
    warm(paint(ellipsoid(0.13, 0.06, 0.12, 0, 0.64, 0.01), SCARF), HEAT_SCARF),
    warm(paint(rod(new THREE.Vector3(0.06, 0.62, 0.11), new THREE.Vector3(0.09, 0.32, 0.19), 0.045, 0.04), SCARF), HEAT_SCARF),
    // The front of the coat lapped over, a seam of fleece down it.
    warm(paint(rod(new THREE.Vector3(-0.05, 0.5, 0.16), new THREE.Vector3(-0.07, -0.38, 0.2), 0.025, 0.03), FLEECE * 0.85), HEAT_FLEECE)
  ])!;

  // The head (origin at the neck): a ruddy face with a short beard, a fur hat with its flaps down.
  const head = mergeGeometries([
    warm(paint(ellipsoid(0.095, 0.115, 0.1, 0, 0.1, 0.01), SKIN), HEAT_FACE),
    warm(paint(ellipsoid(0.025, 0.035, 0.03, 0, 0.09, 0.105), SKIN * 1.05), HEAT_NOSE),
    warm(paint(ellipsoid(0.08, 0.06, 0.07, 0, 0.03, 0.05), BEARD), HEAT_BEARD),
    // The hat: a crown of fur, a brim turned up in front, the flaps down over the ears.
    warm(paint(ellipsoid(0.125, 0.085, 0.125, 0, 0.2, 0.0), HAT, 0.6), HEAT_HAT),
    warm(paint(ellipsoid(0.13, 0.045, 0.06, 0, 0.18, 0.08, -0.3), HAT * 1.15, 0.6), HEAT_HAT),
    warm(paint(ellipsoid(0.04, 0.085, 0.07, 0.1, 0.1, -0.01), HAT), HEAT_HAT),
    warm(paint(ellipsoid(0.04, 0.085, 0.07, -0.1, 0.1, -0.01), HAT), HEAT_HAT),
    warm(paint(ellipsoid(0.1, 0.07, 0.07, 0, 0.13, -0.07), HAT), HEAT_HAT)
  ])!;

  // Thick sleeves with fleece cuffs, and mittens.
  const upperArm = warm(
    limb([
      [0, 0.04, 0.08, 0.08, s],
      [0, -0.12, 0.085, 0.085, s],
      [0, -UPPER_ARM - 0.02, 0.07, 0.07, s]
    ]),
    HEAT_COAT
  );
  const forearm = mergeGeometries([
    warm(
      limb([
        [0, 0.02, 0.07, 0.07, s],
        [0, -0.16, 0.068, 0.068, s],
        [0, -FOREARM + 0.04, 0.075, 0.075, FLEECE * 0.85]
      ]),
      HEAT_COAT
    ),
    warm(paint(ellipsoid(0.05, 0.075, 0.04, 0, -FOREARM - 0.06, 0.01), CLOTH * 1.2), HEAT_MITTEN)
  ])!;

  // Quilted trousers, mostly under the coat; felt boots to the knee.
  const thigh = warm(
    limb([
      [0, 0.06, 0.1, 0.11, CLOTH],
      [0, -0.2, 0.09, 0.1, CLOTH],
      [0, -THIGH - 0.03, 0.075, 0.08, CLOTH]
    ]),
    HEAT_CLOTH
  );
  const shin = mergeGeometries([
    warm(
      limb([
        [0, 0.02, 0.08, 0.085, FELT],
        [0, -0.2, 0.075, 0.08, FELT],
        [0, -SHIN + 0.02, 0.07, 0.075, FELT]
      ]),
      HEAT_BOOTS
    ),
    warm(paint(ellipsoid(0.07, 0.05, 0.13, 0, -SHIN - 0.02, 0.05), FELT), HEAT_BOOTS)
  ])!;
  return { torso, head, upperArm, forearm, thigh, shin };
}

interface Limb {
  upper: THREE.Group;
  lower: THREE.Group;
  side: 1 | -1;
}

/**
 * The man: of middling height, in a sheepskin coat to the knees, a scarf, a fur hat with
 * the flaps down and felt boots, walking home through the forest. He goes about at an
 * easy walk; frightened, he stops dead and turns, then runs for it, weaving between the
 * trees. Seized, he kicks and flails; the story moves him then.
 */
export class Man {
  readonly root = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly veil = { value: 1 };
  heading = 0;
  speed = 0;
  state: State = "hidden";
  /** Where he is making for. */
  readonly goal = new THREE.Vector3();
  /** Held: how hard he struggles, 0..1. Set by the story. */
  struggle = 0;
  private shapes = buildShapes();
  private material: THREE.MeshStandardMaterial;
  private hips = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private arms: Limb[] = [];
  private legs: Limb[] = [];
  private phase = 0;
  private time = 0;
  private stateTime = 0;
  private stepSpeed = 0;
  private want = 0;
  private steerIn = 0;
  /** Seconds left looking back over his shoulder, and until the next look. */
  private glance = 0;
  private glanceIn = 3;
  private fright = 0;
  private from = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private grad = new THREE.Vector2();
  private colliders: Collider[] = [];
  private rand = Math.random;

  constructor() {
    const s = this.shapes;
    const m = (this.material = createCoatMaterial(this.veil, COAT, 1));
    this.root.rotation.order = "YXZ";
    this.hips.position.y = HIP_Y;
    this.root.add(this.hips);
    this.hips.add(this.torso);
    this.torso.rotation.order = "YXZ";
    this.torso.add(new THREE.Mesh(s.torso, m));
    this.head.position.set(0, 0.66, 0.02);
    this.head.rotation.order = "YXZ";
    this.head.add(new THREE.Mesh(s.head, m));
    this.torso.add(this.head);
    for (const side of [1, -1] as const) {
      const upper = new THREE.Group();
      upper.position.set(side * 0.27, 0.5, 0);
      upper.add(new THREE.Mesh(s.upperArm, m));
      const lower = new THREE.Group();
      lower.position.y = -UPPER_ARM;
      lower.add(new THREE.Mesh(s.forearm, m));
      upper.add(lower);
      this.torso.add(upper);
      this.arms.push({ upper, lower, side });
      const thigh = new THREE.Group();
      thigh.position.set(side * 0.1, -0.06, 0);
      thigh.add(new THREE.Mesh(s.thigh, m));
      const knee = new THREE.Group();
      knee.position.y = -THIGH;
      knee.add(new THREE.Mesh(s.shin, m));
      thigh.add(knee);
      this.hips.add(thigh);
      this.legs.push({ upper: thigh, lower: knee, side });
    }
    this.root.visible = false;
  }

  /** Sets him walking at (x, z) towards (gx, gz): there at once, so only ever unseen. */
  spawn(x: number, z: number, gx: number, gz: number): void {
    this.position.set(x, 0, z);
    this.goal.set(gx, 0, gz);
    this.heading = this.want = Math.atan2(gx - x, gz - z);
    this.speed = this.stepSpeed = MAN_WALK;
    this.state = "walk";
    this.stateTime = 0;
    this.steerIn = 0;
    this.fright = 0;
    this.glance = 0;
    this.glanceIn = 2 + this.rand() * 3;
    // Veiled to begin with: the story brings him out of the fog.
    this.veil.value = 1;
    this.struggle = 0;
    this.root.visible = false;
  }

  /** Something roared: he stops dead and turns to look; then he runs for `goal`. */
  startle(from: THREE.Vector3): void {
    if (this.state !== "walk") return;
    this.from.copy(from);
    this.state = "startle";
    this.stateTime = 0;
  }

  /** He has reached the door: in he goes, along the line from (ax, az) to (bx, bz), and is gone. */
  enter(ax: number, az: number, bx: number, bz: number): void {
    this.state = "enter";
    this.stateTime = 0;
    this.goal.set(bx, 0, bz);
    this.from.set(ax, 0, az);
  }

  /** In the yeti's hands: from now on the story stands him where he is held. */
  seize(): void {
    this.state = "held";
    this.stateTime = 0;
    this.speed = 0;
  }

  hide(): void {
    this.state = "hidden";
    this.root.visible = false;
    this.speed = 0;
  }

  /** How far through going in he is, 0..1 (1: inside and out of sight). */
  get inside(): number {
    return this.state === "enter" ? Math.min(1, this.stateTime / MAN_ENTER) : 0;
  }

  /** The middle of his face, in the world. */
  face(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.head.localToWorld(out.set(0, 0.1, 0.1));
  }

  /** Where he is held round the middle, in his own frame (from his feet). */
  static readonly WAIST = HIP_Y + 0.12;

  /** Moves him on the ground (unless held), and animates him. */
  update(dt: number, world: World, height: HeightFn): void {
    if (this.state === "hidden") return;
    this.time += dt;
    this.stateTime += dt;
    const p = this.position;
    if (this.state === "held") {
      this.animate(dt);
      return;
    }
    if (this.state === "enter") {
      // Through the doorway at a run, slowing, and gone into the dark.
      const u = this.inside;
      p.x = lerp(this.from.x, this.goal.x, u);
      p.z = lerp(this.from.z, this.goal.z, u);
      this.heading = Math.atan2(this.goal.x - this.from.x, this.goal.z - this.from.z);
      this.speed = this.stepSpeed = MAN_RUN * (1 - u * 0.6);
      this.place(height);
      this.animate(dt);
      if (u >= 1) this.hide();
      return;
    }

    let goal = MAN_WALK;
    if (this.state === "startle") {
      // Pulled up short, swinging round to face whatever roared.
      goal = 0;
      this.fright = Math.min(1, this.fright + dt * 4);
      const to = Math.atan2(this.from.x - p.x, this.from.z - p.z);
      const turn = 5 * dt;
      this.heading = wrap(this.heading + THREE.MathUtils.clamp(wrap(to - this.heading), -turn, turn));
      this.want = this.heading;
      if (this.stateTime > 0.55) {
        this.state = "run";
        this.stateTime = 0;
        this.steerIn = 0;
      }
    } else if (this.state === "run") {
      heightGradient(height, p.x, p.z, this.grad);
      const uphill = this.grad.x * Math.sin(this.heading) + this.grad.y * Math.cos(this.heading);
      goal = MAN_RUN * slopePace(uphill);
      // Now and then he looks back over his shoulder as he runs, and loses a little ground by it.
      this.glanceIn -= dt;
      if (this.glanceIn <= 0) {
        this.glance = 0.5;
        this.glanceIn = 2.5 + this.rand() * 2.5;
      }
      if (this.glance > 0) {
        this.glance -= dt;
        goal *= 0.88;
      }
    }

    const dist = Math.hypot(this.goal.x - p.x, this.goal.z - p.z);
    const toGoal = Math.atan2(this.goal.x - p.x, this.goal.z - p.z);
    world.collidersNear(p.x, p.z, this.colliders);
    if (this.state !== "startle") {
      this.steerIn -= dt;
      if (this.steerIn <= 0) {
        this.steerIn = 0.15;
        let best = -Infinity;
        for (const off of HEADINGS) {
          if (Math.abs(off) > 2.2) continue;
          const h = toGoal + off;
          const free = freeDistance(p, Math.sin(h), Math.cos(h), this.colliders, LOOK, berth);
          const clear = free >= Math.min(LOOK, dist - 0.3);
          const score = (clear ? 1.2 : free / LOOK) + Math.cos(off) * 0.8 - (free < 1 ? 2 : 0);
          if (score > best) {
            best = score;
            this.want = h;
          }
        }
      }
      const turnRate = (this.state === "run" ? 3.2 : 1.6) * dt;
      this.heading = wrap(this.heading + THREE.MathUtils.clamp(wrap(this.want - this.heading), -turnRate, turnRate));
      goal *= 0.45 + 0.55 * Math.max(0, Math.cos(wrap(this.want - this.heading)));
    }
    this.speed += THREE.MathUtils.clamp(goal - this.speed, -8 * dt, ACCEL * dt);

    const x0 = p.x;
    const z0 = p.z;
    p.x += Math.sin(this.heading) * this.speed * dt;
    p.z += Math.cos(this.heading) * this.speed * dt;
    for (let pass = 0; pass < 2; pass++) {
      for (const c of this.colliders) {
        if (c.walk <= 0) continue;
        const ox = p.x - c.x;
        const oz = p.z - c.z;
        const r = c.walk + BODY;
        const d2 = ox * ox + oz * oz;
        if (d2 < r * r && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          p.x = c.x + (ox / d) * r;
          p.z = c.z + (oz / d) * r;
        }
      }
    }
    const actual = dt > 0 ? Math.hypot(p.x - x0, p.z - z0) / dt : 0;
    this.stepSpeed += (Math.min(this.speed + 0.2, actual) - this.stepSpeed) * (1 - Math.exp(-dt * 6));
    this.place(height);
    this.animate(dt);
  }

  /** Stands him on the snow where he is, feet sunk a little into it. */
  private place(height: HeightFn): void {
    const p = this.position;
    p.y = height(p.x, p.z) - 0.08;
    this.root.position.copy(p);
    this.root.rotation.set(0, this.heading, 0);
    this.root.visible = this.veil.value < 0.999;
  }

  /**
   * Held: his middle at a point in the world, facing a heading, tipped forward (his top
   * towards whatever he faces) by `tip` radians.
   */
  holdAt(waist: THREE.Vector3, heading: number, tip: number): void {
    this.heading = heading;
    this.root.rotation.set(tip, heading, 0);
    this.root.updateMatrix();
    this.tmp.set(0, Man.WAIST, 0).applyQuaternion(this.root.quaternion);
    this.position.copy(waist).sub(this.tmp);
    this.root.position.copy(this.position);
    this.root.visible = true;
  }

  /**
   * Walking, a plodding winter walk; running, a scramble, leaning in, the arms going. Held,
   * the legs kick and the arms beat at what holds him.
   */
  private animate(dt: number): void {
    const run = THREE.MathUtils.smoothstep(this.stepSpeed, 1.6, 3.8);
    const move = Math.min(1, this.stepSpeed / 0.4);
    const cycle = lerp(1.35, 2.6, run);
    this.phase = (this.phase + (this.stepSpeed / cycle) * dt) % 1;
    const a = this.phase * TAU;
    const held = this.state === "held";
    const k = held ? this.struggle : 0;
    const kick = this.time * 13;

    const lean = lerp(0.05, 0.32, run) + (this.state === "startle" ? -0.12 * this.fright : 0);
    this.torso.rotation.set(lean + Math.cos(a * 2) * 0.03 * move + Math.sin(kick * 0.7) * 0.15 * k, -Math.sin(a) * 0.1 * move, Math.sin(kick * 0.5) * 0.1 * k);
    const bob = Math.abs(Math.cos(a)) * lerp(0.03, 0.07, run) * move;
    this.hips.position.set(0, HIP_Y - run * 0.05 + bob, 0);

    for (const leg of this.legs) {
      const as = a + (leg.side > 0 ? 0 : Math.PI);
      const fwd = Math.sin(as);
      const swinging = Math.max(0, Math.cos(as));
      const stride = lerp(0.38, 0.8, run) * move;
      let thigh = -fwd * stride - run * 0.15;
      let knee = 0.05 + swinging * lerp(0.5, 1.3, run) * move;
      // Held, kicking: the legs pedal at the air.
      const pedal = Math.sin(kick + (leg.side > 0 ? 0 : 2.4));
      thigh = lerp(thigh, -0.3 + pedal * 0.55, k);
      knee = lerp(knee, 0.6 + Math.max(0, -pedal) * 0.8, k);
      leg.upper.rotation.set(thigh, 0, leg.side * 0.03);
      leg.lower.rotation.x = knee;
    }
    for (const arm of this.arms) {
      const as = a + (arm.side > 0 ? Math.PI : 0);
      const swing = Math.sin(as) * lerp(0.35, 0.95, run) * move;
      let x = -swing - run * 0.2;
      let z = arm.side * 0.12;
      let elbow = -(0.2 + run * 0.9);
      // Startled, the hands come up a little.
      x = lerp(x, -0.7, this.state === "startle" ? this.fright : 0);
      elbow = lerp(elbow, -1.1, this.state === "startle" ? this.fright : 0);
      // Held, beating at the hands round him.
      const beat = Math.sin(kick * 0.9 + (arm.side > 0 ? 0 : 1.7));
      x = lerp(x, -1.9 + beat * 0.6, k);
      z = lerp(z, arm.side * (0.5 + beat * 0.2), k);
      elbow = lerp(elbow, -0.9 - beat * 0.4, k);
      arm.upper.rotation.set(x, 0, z);
      arm.lower.rotation.x = elbow;
    }
    // He looks where he is going, back over his shoulder when he glances, at the yeti when startled.
    const back = this.glance > 0 ? Math.sin((this.glance / 0.5) * Math.PI) : 0;
    this.head.rotation.set(-this.torso.rotation.x * 0.7 + Math.sin(this.time * 9) * 0.25 * k, back * 1.2 - this.torso.rotation.y * 0.7, 0);
  }

  dispose(): void {
    for (const g of Object.values(this.shapes)) g.dispose();
    this.material.dispose();
  }
}
