import * as THREE from "three";
import { blizzardUniforms } from "../render/fog";
import { Caught } from "./caught";
import type { Stage, StoryCues, StoryEvent } from "./context";
import { EnterHut } from "./enter-hut";
import { HutBeat } from "./hut-beat";
import { SignBeat } from "./sign-beat";
import { CAUGHT, LEASH, YETI_FOCUS, YETI_GUST, YETI_MAX, YETI_MIN } from "./tuning";
import { YetiBeat } from "./yeti-beat";

export type { StoryCues, StoryEvent } from "./context";

/**
 * waiting: not yet walking. wander: walking the forest, a signpost turning up ahead until
 * it is read. read: the sign read, the yeti not yet come. yeti: it is coming, or has
 * roared and is after the walker. flight: the walker has turned to run and the hut is
 * ahead. inside, caught: the two ways it ends, the story moving the camera. ended: over.
 */
type Phase = "waiting" | "wander" | "read" | "yeti" | "flight" | "inside" | "caught" | "ended";

/**
 * The story told over the endless walk. A minute in, a change of direction stands a
 * signpost ahead in the fog; left unread, the forest can be wandered for ever. Some time
 * after it is read, a yeti comes head-on out of the fog and roars. Turning to run brings
 * a hut out of the fog ahead: reach its door and you are safe, get caught and it lifts
 * you to its jaws as the dark comes down.
 *
 * This is the timeline; what each thing does is in its own file beside this one, and
 * every number they are balanced with is in tuning.ts.
 */
export class Story {
  readonly group = new THREE.Group();
  /** Resolves once everything the story will show is ready to be drawn. */
  readonly ready: Promise<void>;
  /** Seconds since walking first started. */
  clock = 0;
  private phase: Phase = "waiting";
  private stage: Stage;
  private signs: SignBeat;
  private pursuit: YetiBeat;
  private refuge: HutBeat;
  private entering: EnterHut;
  private caught: Caught;
  /** Once the sign is read: the yeti comes no sooner than the first of these (on the clock), and by the second. */
  private yetiFrom = Infinity;
  private yetiBy = Infinity;
  /** Where the yeti's face is, as it roars. */
  private yetiFace = new THREE.Vector3();
  /** The yeti has got hold of the walker: its scene has the camera from then on. */
  private seizedByYeti = false;

  constructor(
    stage: Omit<Stage, "rand" | "cues"> & { cues?: StoryCues },
    woodMaterial: THREE.Material,
    private emit: (e: StoryEvent) => void
  ) {
    this.stage = { ...stage, cues: stage.cues ?? {}, rand: Math.random };
    this.signs = new SignBeat(this.stage, woodMaterial, (visible) => this.emit({ type: "sign", visible }));
    this.pursuit = new YetiBeat(this.stage);
    this.refuge = new HutBeat(this.stage, woodMaterial);
    this.entering = new EnterHut(this.stage, this.refuge.hut);
    this.caught = new Caught(this.stage, this.pursuit.yeti);
    this.group.add(this.signs.post.group, this.refuge.hut.group, this.pursuit.yeti.root);
    this.ready = this.signs.post.ready;
  }

  /** The yeti itself, for looking it over from the console: `yeti.preview(x, z, heading, pace, roar)`. */
  get yeti() {
    return this.pursuit.yeti;
  }

  /** 0..1: how far the screen has gone black, on the way into the hut or in the yeti's hands. */
  get blackout(): number {
    return this.seizedByYeti ? this.caught.blackout : this.entering.blackout;
  }

  /**
   * While loading: stands everything the story will ever show far below the snow, so one
   * frame drawn then builds every shader and sends every shape and texture to the graphics
   * card, and nothing is left to do on the frame something first comes into view.
   * reset() puts it all away again.
   */
  showForWarmUp(): void {
    this.signs.post.place(0, 0, 0, 1, () => -500);
    this.refuge.hut.place(0, -500, 0, 0, 1);
    this.pursuit.yeti.root.position.set(0, -500, 0);
    this.pursuit.yeti.root.visible = true;
  }

  /** Whether the yeti is about: the deer make off, and keep away. */
  get chasing(): boolean {
    return this.phase !== "waiting" && this.phase !== "wander" && this.phase !== "read";
  }

  /** 0..1: the chase is on, from the yeti's roar to safety or the dark; higher the nearer it gets. */
  get tension(): number {
    if (this.phase === "caught") return 1;
    if ((this.phase === "yeti" && this.pursuit.met) || this.phase === "flight") {
      const near = 1 - THREE.MathUtils.clamp((this.pursuit.distance - CAUGHT) / (LEASH - CAUGHT), 0, 1);
      return 0.55 + 0.45 * near;
    }
    return 0;
  }

  /** Whether the story has the camera (going into the hut or caught, and after). */
  get driving(): boolean {
    return this.phase === "inside" || this.phase === "caught" || this.phase === "ended";
  }

  /** Back to the very beginning. Call it with the screen black. */
  reset(): void {
    this.phase = "waiting";
    this.clock = 0;
    this.yetiFrom = Infinity;
    this.yetiBy = Infinity;
    this.seizedByYeti = false;
    this.signs.reset();
    this.pursuit.reset();
    this.refuge.reset();
    this.entering.reset();
    this.caught.reset();
    this.stage.world.clearProps();
    this.stage.steering.locked = false;
  }

  /** For trying the story out: skips the wait for whatever comes next. */
  skip(): void {
    if (this.phase === "waiting") this.phase = "wander";
    if (this.phase === "wander") this.signs.skip();
    else if (this.phase === "read") this.yetiFrom = this.yetiBy = this.clock;
    else if (this.phase === "yeti") this.pursuit.skip();
  }

  /** Call every frame, once the camera's matrices and the sight are up to date. */
  update(dt: number): void {
    if (this.phase === "waiting") {
      if (!this.stage.steering.walking) {
        this.pursuit.idle(dt);
        return;
      }
      this.phase = "wander";
    }
    this.clock += dt;
    switch (this.phase) {
      case "wander":
        if (this.signs.update(dt, true)) {
          this.phase = "read";
          this.yetiFrom = this.clock + YETI_MIN;
          this.yetiBy = this.clock + YETI_MAX;
        }
        break;
      case "read":
        this.signs.update(dt, true);
        // With the first gust once it may come: the snow begins to howl.
        if (this.clock >= this.yetiBy || (this.clock >= this.yetiFrom && blizzardUniforms.uGust.value >= YETI_GUST)) {
          if (this.pursuit.spawn()) this.phase = "yeti";
        }
        break;
      case "yeti":
      case "flight":
        // The words stay while it is still only a shape in the fog; they go when it roars.
        this.signs.update(dt, !this.pursuit.met);
        this.chase(dt);
        break;
    }
  }

  private chase(dt: number): void {
    const pursuit = this.pursuit;
    pursuit.update(dt);
    if (pursuit.justRoared) {
      pursuit.justRoared = false;
      this.signs.hush();
      // It rears up roaring: the head turns to it, wherever it is, and they stand rooted.
      this.stage.walker.focusOn(pursuit.yeti.face(this.yetiFace), YETI_FOCUS, true);
    }
    // Its face, kept up to date while it is looked at.
    if (pursuit.yeti.state === "roar") pursuit.yeti.face(this.yetiFace);
    if (pursuit.reached) {
      this.seized();
      return;
    }
    // Until it has roared there is nothing to run from, and no hut.
    if (!pursuit.met) return;
    if (this.phase === "yeti") {
      if (pursuit.fled && this.refuge.raise()) this.phase = "flight";
      return;
    }
    pursuit.leash();
    if (this.refuge.passed(dt)) return;
    if (this.refuge.atDoor()) this.goInside();
  }

  /** Going into the hut, or caught: the story moves the camera instead of the walker. */
  drive(dt: number): void {
    if (this.phase === "caught" || (this.phase === "ended" && this.seizedByYeti)) {
      // Caught, the story keeps the camera in its hands to the end, through the end screen.
      if (this.caught.update(dt) && this.phase === "caught") {
        this.phase = "ended";
        this.emit({ type: "eaten" });
      }
    } else if (this.phase === "inside" || this.phase === "ended") {
      if (this.entering.update(dt) && this.phase === "inside") {
        this.phase = "ended";
        this.emit({ type: "escaped" });
      }
    }
  }

  private goInside(): void {
    this.phase = "inside";
    this.entering.begin();
    this.pursuit.yeti.halt();
    this.takeOver();
    this.emit({ type: "inside" });
  }

  /** It has you: the walk is over, and the story takes the camera. */
  private seized(): void {
    this.phase = "caught";
    this.seizedByYeti = true;
    this.caught.begin();
    this.takeOver();
    this.emit({ type: "caught" });
  }

  private takeOver(): void {
    this.signs.hush();
    this.stage.steering.locked = true;
    this.stage.steering.setWalking(false);
  }

  dispose(): void {
    this.signs.dispose();
    this.refuge.dispose();
    this.pursuit.dispose();
  }
}
