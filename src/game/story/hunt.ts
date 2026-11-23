import * as THREE from "three";
import { Man } from "../actors/man";
import { YETI_BODY } from "../actors/player";
import { Paws, type PawsPose } from "../actors/yeti";
import { smooth, wrap } from "../lib/math";
import type { Collider } from "../world/collider";
import { Hut } from "../props/hut";
import { HEAT_FOG } from "../render/fog";
import { forward, heard, lineClear, type Stage, type StoryEvent } from "./context";
import { HutBeat } from "./hut-beat";
import {
  DOORSTEP_OUT,
  DOORSTEP_REACH,
  FEAST_HOLD,
  FEAST_LEAD,
  FEAST_LIFT,
  FEAST_LOWER,
  GRAB,
  GROWL_EVERY,
  GROWL_SPREAD,
  HEARD,
  HELD_OUT,
  HELD_UP,
  HUNT_AFTER,
  HUNT_AGAIN,
  HUNT_GIVE_UP,
  HUNT_ROAR,
  HUNT_SPREAD,
  IN_THE_DOOR,
  LEASH,
  MAN_BEARINGS,
  MAN_DEEPER,
  MAN_EMERGE,
  MAN_FAR,
  MAN_GOAL,
  MAN_GONE,
  MAN_HIDE,
  MAN_LOST,
  MAN_LOST_FOR,
  MAN_NEAR,
  MAN_PASS,
  MAN_PASSING,
  MAN_RIM,
  MAN_ROAM,
  MOUTH_DOWN,
  MOUTH_OUT,
  REFUGE_ASIDE,
  REFUGE_BEARINGS,
  REFUGE_DIST,
  REFUGE_HIDE,
  SHUT_DARK,
  SHUT_HOLD,
  SPOT_CLOSE,
  SPOT_DIST,
  SPOT_TIME,
  YETI_CHARGE
} from "./tuning";

/**
 * waiting: not yet walking. prowl: ambling through the forest, the man somewhere about or
 * yet to come. roar: it has seen him, and stands roaring, arms up. chase: after him. feast:
 * caught, through its eyes. shut: he got in, the door is shut. ended: over.
 */
type Phase = "waiting" | "prowl" | "roar" | "chase" | "feast" | "shut" | "ended";

/** When, in seconds from the grab, he starts coming down to its mouth, and when it is over. */
const LOWER_FROM = FEAST_LIFT - FEAST_LEAD;
const FEAST_OVER = LOWER_FROM + FEAST_LOWER + FEAST_HOLD;

/**
 * The third walk, through the yeti's eyes. It ambles through deep forest; some while in, a
 * man comes walking through the trees, glowing with the heat it sees. Spotting him, it
 * roars with its arms flung up and charges; he runs for a hut. Reach him before he is
 * through the door and it has him; let him get in, and the door shuts in its face.
 *
 * It plays the same part for main.ts as the Story does on the other walks.
 */
export class Hunt {
  readonly group = new THREE.Group();
  clock = 0;
  readonly man = new Man();
  readonly paws = new Paws();
  private phase: Phase = "waiting";
  private refuge: HutBeat;
  /** Whether there is a hut for him to run to (else he runs off into the forest). */
  private haven = false;
  /** On the clock: when he next comes, unless he is about. */
  private comeAt = Infinity;
  private since = 0;
  /** Which side of the yeti he passes. */
  private passSide = 1;
  private seenFor = 0;
  private offFor = 0;
  private growlIn = 0;
  private t = 0;
  private dark = 0;
  /**
   * Caught: the yeti's eyes, the way it faced and the way it turns to face him, and where
   * he was, when it got hold of him.
   */
  private eye = new THREE.Vector3();
  private yawFrom = 0;
  private yaw = 0;
  private pitch = 0;
  private grabbedAt = new THREE.Vector3();
  /** His face, for looking at him as it roars. */
  private manFace = new THREE.Vector3();
  private gulped = false;
  private pose: PawsPose = { roar: 0, run: 0, reach: 0, hold: 0 };
  private grip: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];
  private colliders: Collider[] = [];
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmp3 = new THREE.Vector3();

  constructor(
    private stage: Stage,
    woodMaterial: THREE.Material,
    private emit: (e: StoryEvent) => void
  ) {
    this.refuge = new HutBeat(stage, woodMaterial);
    this.group.add(this.man.root, this.paws.root, this.refuge.hut.group);
  }

  /** 0..1: how far the screen has gone black. */
  get blackout(): number {
    return this.dark;
  }

  /** Whether there is something to run from: the deer make off. */
  get chasing(): boolean {
    return this.phase !== "waiting" && this.phase !== "prowl";
  }

  /** 0..1: the hunt is on, from the roar to the door or the dark; higher the nearer he is. */
  get tension(): number {
    if (this.phase === "feast") return 1;
    if (this.phase === "roar" || this.phase === "chase") {
      const near = 1 - THREE.MathUtils.clamp((this.distance - GRAB) / (LEASH - GRAB), 0, 1);
      return 0.55 + 0.45 * near;
    }
    return 0;
  }

  /** Whether the story has the camera. */
  get driving(): boolean {
    return this.phase === "feast" || this.phase === "ended";
  }

  /** While loading: everything it will show, far under the snow, for the warm-up frame. */
  showForWarmUp(): void {
    this.man.root.position.set(0, -500, 0);
    this.man.root.visible = true;
    this.man.veil.value = 0;
    this.paws.root.position.set(0, -500, 0);
    this.paws.root.visible = true;
    this.refuge.hut.place(0, -500, 0, 0, 1);
  }

  /** Back to the very beginning. Call it with the screen black. */
  reset(): void {
    this.phase = "waiting";
    this.clock = 0;
    this.comeAt = HUNT_AFTER + this.stage.rand() * HUNT_SPREAD;
    this.dark = 0;
    this.haven = false;
    this.man.hide();
    this.paws.show(false);
    this.refuge.reset();
    this.pose.roar = this.pose.run = this.pose.reach = this.pose.hold = 0;
    this.pose.grip = undefined;
  }

  /** The yeti's walk begins: its arms, its pace. */
  begin(): void {
    this.reset();
    this.paws.show(true);
    this.stage.walker.pace = YETI_BODY.run;
  }

  /** For trying it out: brings the man now, or has it spot him now. */
  skip(): void {
    if (this.phase === "waiting") this.phase = "prowl";
    if (this.phase !== "prowl") return;
    if (this.man.state === "hidden") this.comeAt = this.clock;
    else this.spotted();
  }

  update(dt: number): void {
    const { walker, steering } = this.stage;
    if (this.phase === "waiting") {
      if (!steering.walking) {
        this.arms(dt);
        return;
      }
      this.phase = "prowl";
    }
    this.clock += dt;
    if (this.phase === "prowl") this.prowl(dt);
    else if (this.phase === "roar") {
      this.t += dt;
      this.man.update(dt, this.stage.world, this.stage.height);
      this.man.face(this.manFace);
      // Rearing up, it shakes with the roar.
      const shake = Math.sin(this.t * 37) * 0.012 * (1 - smooth((this.t - 0.9) / 0.4));
      this.stage.camera.rotation.z += shake;
      this.stage.camera.rotation.x += Math.abs(shake) * 0.8 + 0.05 * smooth(this.t / 0.3) * (1 - smooth((this.t - 0.9) / 0.4));
      if (this.t >= HUNT_ROAR) {
        this.phase = "chase";
        this.t = 0;
        walker.pace = YETI_CHARGE;
      }
      if (this.reached()) this.seize();
    } else if (this.phase === "chase") this.chase(dt);
    else if (this.phase === "shut") this.shut(dt);
    if (this.phase !== "feast" && this.phase !== "ended") this.arms(dt);
  }

  /** The arms, following the eyes, in whatever pose the moment wants. */
  private arms(dt: number): void {
    const { walker, camera } = this.stage;
    const pose = this.pose;
    const k = 1 - Math.exp(-dt * 6);
    pose.roar += ((this.phase === "roar" && this.t > 0.1 ? 1 : 0) - pose.roar) * (1 - Math.exp(-dt * (this.phase === "roar" ? 9 : 4)));
    pose.run += (Math.min(1, walker.speed / YETI_CHARGE) - pose.run) * k;
    const near = this.phase === "chase" ? 1 - THREE.MathUtils.smoothstep(this.distance, 3, 7) : 0;
    pose.reach += (near - pose.reach) * k;
    this.paws.update(dt, camera.position, walker.yaw, pose);
  }

  /** How far he is from the yeti, over the ground. */
  private get distance(): number {
    const p = this.stage.walker.position;
    return Math.hypot(this.man.position.x - p.x, this.man.position.z - p.z);
  }

  /** Its hands are on him (and he is not yet through the door). */
  private reached(): boolean {
    const m = this.man;
    if (m.state === "hidden" || m.state === "held" || m.inside > IN_THE_DOOR) return false;
    return this.distance < GRAB;
  }

  private prowl(dt: number): void {
    const { walker, sight, world, height } = this.stage;
    const man = this.man;
    if (man.state === "hidden") {
      if (this.clock >= this.comeAt && !this.bring()) this.comeAt = this.clock + 1;
      return;
    }
    man.update(dt, world, height);
    // Out of the fog: his glow comes up from nothing, however clear the air.
    man.veil.value = Math.max(0, man.veil.value - dt / MAN_EMERGE);
    this.since += dt;
    const p = walker.position;
    const m = man.position;
    const dist = this.distance;
    const on = sight.inView(m.x, m.z, 0.9, 1.1);
    this.offFor = on ? 0 : this.offFor + dt;
    // Coming, he makes for a point beside the yeti wherever it has got to; near, he walks on past.
    if (dist > MAN_PASSING) this.passBy(man.goal);
    else if (Math.hypot(man.goal.x - m.x, man.goal.z - m.z) < 6) {
      const h = man.heading;
      man.goal.set(m.x + Math.sin(h) * MAN_GOAL, 0, m.z + Math.cos(h) * MAN_GOAL);
    }
    // In sight: his middle on screen, near enough to make out, and no trunk square between
    // (nearer than SPOT_CLOSE his glow shows through the boughs anyway).
    const plain =
      sight.inView(m.x, m.z, 1, 0) &&
      dist < SPOT_DIST &&
      sight.overSnow(p, m.x, m.z, 1.5) &&
      (dist < SPOT_CLOSE || lineClear(this.trees(p.x, p.z, m.x, m.z), p.x, p.z, m.x, m.z, (c) => (c.walk > 0 && !c.log && !c.mound ? c.walk * 0.25 : 0)));
    this.seenFor = plain ? this.seenFor + dt : 0;
    if (this.seenFor >= SPOT_TIME || dist < HEARD) {
      this.spotted();
      return;
    }
    // Lost track of: taken away unseen, and he comes again a little later.
    if ((this.offFor >= MAN_LOST_FOR && dist > MAN_LOST) || (this.since > MAN_ROAM && this.offFor > 2)) {
      man.hide();
      this.comeAt = this.clock + HUNT_AGAIN;
    }
  }

  /** Every collider between two points. */
  private trees(ax: number, az: number, bx: number, bz: number): Collider[] {
    return this.stage.world.collidersIn(Math.min(ax, bx) - 2, Math.min(az, bz) - 2, Math.max(ax, bx) + 2, Math.max(az, bz) + 2, this.colliders);
  }

  /**
   * The man comes: ahead, a little to one side, so deep in the fog that not even his heat
   * shows, walking towards the yeti at a slant, across its way to the other side. Coming
   * on, it sees him first as a glow in the fog.
   */
  private bring(): boolean {
    const { walker, sight, world, rand } = this.stage;
    const p = walker.position;
    const [fx, fz] = forward(walker);
    const ahead = Math.atan2(fx, fz);
    const side = rand() < 0.5 ? 1 : -1;
    const near = THREE.MathUtils.clamp(sight.hiddenBeyond(MAN_HIDE) / HEAT_FOG, MAN_NEAR, Math.min(MAN_FAR, world.radius - MAN_RIM));
    for (const off of MAN_BEARINGS) {
      for (const more of MAN_DEEPER) {
        const d = near + more;
        const x = p.x + Math.sin(ahead + side * off) * d;
        const z = p.z + Math.cos(ahead + side * off) * d;
        if (!world.loaded(x, z, 4)) continue;
        let blocked = false;
        for (const c of world.collidersNear(x, z, this.colliders)) {
          if (c.walk > 0 && Math.hypot(c.x - x, c.z - z) < c.walk + 0.6) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        // He passes it by on one side or the other.
        this.passSide = side;
        this.man.spawn(x, z, x, z);
        this.passBy(this.man.goal);
        this.man.heading = Math.atan2(this.man.goal.x - x, this.man.goal.z - z);
        this.since = this.seenFor = this.offFor = 0;
        return true;
      }
    }
    return false;
  }

  /** A point MAN_PASS metres beside the yeti, on his side for passing it, a little beyond it from him. */
  private passBy(out: THREE.Vector3): THREE.Vector3 {
    const p = this.stage.walker.position;
    const m = this.man.position;
    const dx = p.x - m.x;
    const dz = p.z - m.z;
    const len = Math.hypot(dx, dz) || 1;
    // Square to his way to it, on the side he passes it by.
    const sx = (-dz / len) * this.passSide;
    const sz = (dx / len) * this.passSide;
    return out.set(p.x + sx * MAN_PASS + (dx / len) * 4, 0, p.z + sz * MAN_PASS + (dz / len) * 4);
  }

  /** It has seen him: it roars, he turns to look and runs for the hut, without a sound. */
  private spotted(): void {
    const { walker, sight, cues } = this.stage;
    const man = this.man;
    const p = walker.position;
    const m = man.position;
    this.phase = "roar";
    this.t = 0;
    walker.pace = 0.25;
    cues.cue?.("growl", 0, 1);
    man.veil.value = 0;
    man.startle(p);
    // The head turns to him, for as long as it roars.
    walker.focusOn(man.face(this.manFace), HUNT_ROAR);
    // The hut: on from him, away from the yeti, its door his way; out of view or deep in the fog.
    const dx = m.x - p.x;
    const dz = m.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const hidden = (x: number, z: number) => !sight.inView(x, z, 2, 6) || Math.hypot(x - p.x, z - p.z) > sight.hiddenBeyond(REFUGE_HIDE);
    this.haven = this.refuge.place(dx / len, dz / len, REFUGE_DIST, REFUGE_BEARINGS, REFUGE_ASIDE, m, hidden);
    if (this.haven) this.refuge.hut.doorstep(man.goal, DOORSTEP_OUT);
    // Nowhere for a hut: he runs straight off into the forest.
    else man.goal.set(m.x + (dx / len) * 200, 0, m.z + (dz / len) * 200);
    this.growlIn = GROWL_EVERY;
  }

  private chase(dt: number): void {
    const { walker, sight, world, height, cues, rand } = this.stage;
    const man = this.man;
    this.t += dt;
    man.update(dt, world, height);
    // Running, it snarls now and then.
    this.growlIn -= dt;
    if (this.growlIn <= 0) {
      this.growlIn = GROWL_EVERY + rand() * GROWL_SPREAD;
      cues.cue?.("growl", 0, 0.45);
    }
    if (this.reached()) {
      this.seize();
      return;
    }
    const hut = this.refuge.hut;
    // His goal is the doorstep: there, in he goes.
    if (this.haven && man.state === "run") {
      if (Math.hypot(man.goal.x - man.position.x, man.goal.z - man.position.z) < DOORSTEP_REACH) {
        const inside = hut.gap(this.tmp2, -1.4);
        man.enter(man.position.x, man.position.z, inside.x, inside.z);
        const [hp] = heard(walker, hut.position.x, hut.position.z, 10);
        cues.cue?.("creak", hp, 0.7);
      }
    }
    // The door gives before him, all the way by the time he is half through.
    if (man.state === "enter") hut.setDoor(smooth(man.inside / 0.5));
    // In: the door slams to behind him.
    if (man.state === "hidden") {
      this.phase = "shut";
      this.t = 0;
      walker.pace = YETI_BODY.run;
      const [hp, hl] = heard(walker, hut.position.x, hut.position.z, 50);
      cues.cue?.("stomp", hp, Math.max(0.3, hl));
      this.emit({ type: "inside" });
      return;
    }
    // Run off into the forest with no hut to hide in, or never caught: he is gone.
    const lost = !this.haven && this.distance > MAN_GONE && !sight.inView(man.position.x, man.position.z, 0.9, 1.1);
    if (lost || this.t > HUNT_GIVE_UP) {
      man.hide();
      this.phase = "shut";
      this.t = 0;
      this.emit({ type: "inside" });
    }
  }

  /** He got away. The door shut, it stands a moment; then the dark comes over its eyes. */
  private shut(dt: number): void {
    const { steering } = this.stage;
    this.t += dt;
    const hut = this.refuge.hut;
    if (this.haven) hut.setDoor(THREE.MathUtils.lerp(hut.door, Hut.SHUT, 1 - Math.exp(-dt * 14)));
    steering.locked = true;
    steering.setWalking(false);
    this.dark = smooth((this.t - SHUT_HOLD) / SHUT_DARK);
    if (this.t >= SHUT_HOLD + SHUT_DARK + 0.4) {
      this.phase = "ended";
      this.emit({ type: "escaped" });
    }
  }

  /** Its hands close on him: from here the story has the eyes. */
  private seize(): void {
    const { walker, camera, steering, cues } = this.stage;
    this.phase = "feast";
    this.t = 0;
    this.gulped = false;
    this.man.seize();
    this.man.struggle = 1;
    this.eye.copy(camera.position);
    this.yawFrom = walker.yaw;
    this.pitch = camera.rotation.x;
    this.grabbedAt.copy(this.man.position);
    this.grabbedAt.y += Man.WAIST;
    // It swings round to face him, whichever way it was looking.
    const m = this.man.position;
    this.yaw = this.yawFrom + wrap(Math.atan2(-(m.x - this.eye.x), -(m.z - this.eye.z)) - this.yawFrom);
    steering.locked = true;
    steering.setWalking(false);
    cues.cue?.("growl", 0, 0.8);
    this.emit({ type: "caught" });
  }

  /**
   * Caught: lifted overhead, brought down to its mouth, through its eyes. He is wherever
   * its palms are (they reach for where he should be, as far as its arms go), so he is
   * never seen floating out of its grasp.
   */
  drive(dt: number): void {
    const { camera: cam, walker, cues } = this.stage;
    if (this.phase === "ended") return;
    this.t += dt;
    const man = this.man;
    // Swinging round to face him, as quickly as it looks up at him.
    const look = smooth(this.t / 0.35);
    const yaw = this.yawFrom + wrap(this.yaw - this.yawFrom) * look;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const up = smooth(this.t / FEAST_LIFT);
    const down = smooth((this.t - LOWER_FROM) / FEAST_LOWER);
    if (down > 0 && !this.gulped) {
      this.gulped = true;
      cues.cue?.("growl", 0, 1);
    }
    // Where his middle should be: from where it got hold of him, up overhead, then down to its mouth.
    const want = this.tmp.copy(this.grabbedAt);
    const over = this.tmp2.set(this.eye.x + fx * HELD_OUT, this.eye.y + HELD_UP + Math.sin(this.t * 2.1) * 0.04, this.eye.z + fz * HELD_OUT);
    want.lerp(over, up);
    const mouth = this.tmp3.set(this.eye.x + fx * MOUTH_OUT, this.eye.y - MOUTH_DOWN, this.eye.z + fz * MOUTH_OUT);
    want.lerp(mouth, down);
    // Its hands go round there, one at each side (the first arm is its left).
    const sx = -Math.cos(yaw) * 0.26;
    const sz = Math.sin(yaw) * 0.26;
    this.grip[0].set(want.x + sx, want.y, want.z + sz);
    this.grip[1].set(want.x - sx, want.y, want.z - sz);
    const pose = this.pose;
    pose.grip = this.grip;
    pose.hold = Math.min(1, pose.hold + dt * 8);
    pose.roar = pose.run = 0;
    pose.reach = 1 - pose.hold;
    // The eyes stay where they were; it sways with the weight.
    const prev = this.tmp2.copy(cam.position);
    cam.position.copy(this.eye);
    cam.position.y += Math.sin(this.t * 1.7) * 0.03 * up;
    if (dt > 0) walker.velocity.subVectors(cam.position, prev).divideScalar(dt);
    this.paws.update(dt, cam.position, yaw, pose);
    // He is between its palms, pulled into them from where he stood as they close.
    const held = this.paws.palms(this.tmp2).lerp(want, 1 - smooth(this.t / 0.4));
    man.struggle = 1 - down * 0.5;
    // He faces it, kicking, tipped towards it as he comes down.
    man.holdAt(held, Math.atan2(-fx, -fz), down * 0.35 + Math.sin(this.t * 5) * 0.06 * (1 - down));
    man.update(dt, this.stage.world, this.stage.height);
    // Looking up at his face, and down with it.
    const face = man.face(this.tmp3);
    const pitchTo = Math.atan2(face.y - cam.position.y, Math.hypot(face.x - cam.position.x, face.z - cam.position.z));
    cam.rotation.set(THREE.MathUtils.lerp(this.pitch, pitchTo, look), yaw, Math.sin(this.t * 1.3) * 0.04 * up);
    this.dark = smooth((down - 0.4) / 0.45);
    if (this.t >= FEAST_OVER) {
      this.phase = "ended";
      this.emit({ type: "eaten" });
    }
  }

  dispose(): void {
    this.man.dispose();
    this.paws.dispose();
    this.refuge.dispose();
  }
}
