import * as THREE from "three";
import { blizzardUniforms } from "../render/fog";
import type { HeightFn } from "./terrain";

/**
 * The air is uneven: streaks of it are thinner or thicker than the weather's own figure
 * (see bzFogDensity in fog.ts: with the thicker air near the ground, about 1.2 times it on
 * an ordinary ray at the height of a body, under 0.8 on one ray in ten). To be sure a thing
 * is HIDDEN, reckon with a thin streak; to judge whether it can be SEEN, with ordinary air.
 */
const THIN_AIR = 0.8;
const ORDINARY_AIR = 1.2;
/** A gust thickens the air at once; hiding is reckoned with air that follows it only over this many seconds, so a thing hidden in a gust stays hidden as it dies. */
const THICKENS_OVER = 8;

/**
 * What the walker can see, as far as the story and the deer need to know: what is on
 * screen, what a rise in the snow hides, and how far the fog lets anything through.
 * Nothing may come or go where it would be seen to, and this is where that is judged.
 */
export class Sight {
  /** Half the horizontal field of view, radians. */
  halfView = 0.9;
  /** View and projection in one, as of the last update(). */
  readonly projView = new THREE.Matrix4();
  private frustum = new THREE.Frustum();
  private sphere = new THREE.Sphere();
  /** The weather's fog density now, and at its clearest lately. */
  private air = 0;
  private clearest = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private height: HeightFn
  ) {}

  /** Call once a frame, when the camera's matrices are up to date. */
  update(dt: number): void {
    const cam = this.camera;
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    this.halfView = Math.atan(Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.aspect);
    const k = (this.air = blizzardUniforms.uFogDensity.value);
    this.clearest = this.clearest <= 0 || k < this.clearest ? k : this.clearest + (k - this.clearest) * (1 - Math.exp(-dt / THICKENS_OVER));
  }

  /** Whether anything this big, standing on the snow here, could be on screen. */
  inView(x: number, z: number, up: number, radius: number): boolean {
    this.sphere.center.set(x, this.height(x, z) + up, z);
    this.sphere.radius = radius;
    return this.frustum.intersectsSphere(this.sphere);
  }

  /** No rise in the snow between an eye and a point `up` above the ground at (x, z). */
  overSnow(eye: THREE.Vector3, x: number, z: number, up: number, samples = 16): boolean {
    return this.overSnowFrom(eye.x, eye.y, eye.z, x, z, up, samples);
  }

  /** The same, from wherever an eye would be. */
  overSnowFrom(ex: number, ey: number, ez: number, x: number, z: number, up: number, samples = 16): boolean {
    const ty = this.height(x, z) + up;
    for (let i = 1; i < samples; i++) {
      const t = i / samples;
      if (this.height(ex + (x - ex) * t, ez + (z - ez) * t) > ey + (ty - ey) * t - 0.1) return false;
    }
    return true;
  }

  /**
   * Further off than this, in metres, the fog hides a thing: no more than `share` (0..1) of
   * it comes through, even along a thin streak of the clearest air there has been lately.
   * (The fog passes exp(-(k d)^2).)
   */
  hiddenBeyond(share: number): number {
    return Math.sqrt(-Math.log(share)) / (THIN_AIR * Math.max(this.clearest, 1e-4));
  }

  /** Nearer than this, in metres, a thing shows: at least `share` (0..1) of it comes through ordinary air as it is now. */
  seenWithin(share: number): number {
    return Math.sqrt(-Math.log(share)) / (ORDINARY_AIR * Math.max(this.air, 1e-4));
  }
}
