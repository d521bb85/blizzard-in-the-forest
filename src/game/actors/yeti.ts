import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { TAU, lin, wrap } from "../lib/math";
import { mulberry32 } from "../lib/noise";
import { heightGradient, type HeightFn } from "../world/terrain";
import type { Collider } from "../world/collider";
import type { World } from "../world/world";
import { createCoatMaterial, dye, ellipsoid, loft, paint, rod, warm, type CoatPalette, type Ring } from "./creature";
import { HEADINGS, freeDistance, slopePace } from "./steer";

/** Fur: a pale, dirty grey that still stands out from the fog; face, palms and soles dark. */
const FUR = 0.68;
const SKIN = 0.16;
/**
 * In colour: fur a dirty blue-white, greyer in its shadows and yellowed underneath, the
 * bare skin a dark slate. The eyes burn amber, the fangs and claws are old ivory and
 * horn, and the inside of the mouth is a dark red.
 */
const COAT: CoatPalette = {
  dark: 0x383a4b,
  mid: 0x8695a6,
  pale: 0xdde6ec,
  stops: [0.22, 0.45, 0.8],
  under: 0xa6a596
};
const EYE = 0xe08c24;
const EYE_GLOW = 0.5;
const FANG = 0xd4ccac;
const CLAW = 0x8a8068;
const MAW = 0x4a0c0c;
/** Hips stand this high; the legs never quite straighten, so they reach a little less far. */
const HIP_Y = 1.04;
const THIGH = 0.52;
const SHIN = 0.5;
const UPPER_ARM = 0.6;
const FOREARM = 0.58;
/**
 * Coming on out of the fog it walks, at whatever pace the story sets (STALK to begin with);
 * chasing, it runs at CHASE: a little slower than a flat-out run (RUN in player.ts), getting
 * up to it at ACCEL.
 */
const STALK = 1.8;
export const CHASE = 5.3;
const ACCEL = 2.5;
/** How long it stands and roars before it runs: the walker's head start. */
export const ROAR_TIME = 2;
/** Its bulk, for keeping out of trees: what the walker bumps into, plus this. */
const BODY = 0.42;
const LOOK = 5;
/**
 * Through its own eyes, which see heat: its arms glow faintly through the fur, the bare
 * palms and fingers more (as a share of the arms' warmth).
 */
const ARM_WARMTH = 0.15;
const PALM_HEAT = 3;

type Rand = () => number;
type V = THREE.Vector3;
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Roughs a shape's surface up a little (every vertex pushed out along its normal by a
 * random amount), shades it darker underneath, and facets it flat.
 */
function shag(geo: THREE.BufferGeometry, rand: Rand, amount: number): THREE.BufferGeometry {
  geo.deleteAttribute("normal");
  geo.deleteAttribute("uv");
  let g = mergeVertices(geo, 1e-4);
  g.computeVertexNormals();
  const pos = g.attributes.position as THREE.BufferAttribute;
  const n = g.attributes.normal as THREE.BufferAttribute;
  const col = g.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const k = amount * (0.3 + rand() * 0.7);
    pos.setXYZ(i, pos.getX(i) + n.getX(i) * k, pos.getY(i) + n.getY(i) * k - k * 0.3, pos.getZ(i) + n.getZ(i) * k);
    const tint = 0.74 + 0.2 * n.getY(i) + rand() * 0.2;
    col.setXYZ(i, col.getX(i) * tint, col.getY(i) * tint, col.getZ(i) * tint);
  }
  g = g.toNonIndexed();
  g.computeVertexNormals();
  return g;
}

/** Faceted as it is: for the parts that stay smooth (face, hands, feet). */
function facet(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.deleteAttribute("uv");
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

/**
 * Loose triangles, each wound to face away from a centre given with it, and lit as the
 * surface they grow from (a normal given with them), not as the thin wedges they are:
 * the coat shades as one, and the locks show only in its broken outline and texture.
 */
class Shards {
  private pos: number[] = [];
  private col: number[] = [];
  private nor: number[] = [];
  private ab = new THREE.Vector3();
  private ac = new THREE.Vector3();
  private n = new THREE.Vector3();
  private m = new THREE.Vector3();

  tri(a: V, b: V, c: V, ga: number, gb: number, gc: number, centre: V, normal: V): void {
    this.n.crossVectors(this.ab.subVectors(b, a), this.ac.subVectors(c, a));
    this.m.copy(a).add(b).add(c).divideScalar(3).sub(centre);
    if (this.n.dot(this.m) < 0) {
      [b, c] = [c, b];
      [gb, gc] = [gc, gb];
    }
    for (const [p, g] of [
      [a, ga],
      [b, gb],
      [c, gc]
    ] as [V, number][]) {
      this.pos.push(p.x, p.y, p.z);
      this.nor.push(normal.x, normal.y, normal.z);
      const l = lin(Math.min(1, g));
      this.col.push(l, l, l);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("own", new THREE.BufferAttribute(new Float32Array((this.pos.length / 3) * 4), 4));
    g.setAttribute("heat", new THREE.BufferAttribute(new Float32Array(this.pos.length / 3).fill(1), 1));
    return g;
  }
}

interface Fringe {
  /** Height of the ring, and its middle front to back. */
  y: number;
  z?: number;
  /** Half-widths of the ring (across, front to back). */
  rx: number;
  rz: number;
  count: number;
  /** How long the locks hang. */
  len: number;
  /** How far out they flare, per metre of length. */
  spread?: number;
  /** How far they sweep back (+ forward), per metre of length. */
  sweep?: number;
  /** Leaves out locks at bearings this returns true for (0 is +X, PI/2 is the front). */
  skip?: (a: number) => boolean;
  gray?: number;
}

/**
 * A ring of shaggy locks round a body or limb: overlapping flat wedges hanging down
 * and out, each a different length, so the outline breaks up into long, layered hair
 * instead of a smooth surface. Their tops catch the light, their tips sink into shadow.
 */
function fringe(rand: Rand, f: Fringe): THREE.BufferGeometry {
  const s = new Shards();
  const z0 = f.z ?? 0;
  const spread = f.spread ?? 0.3;
  const sweep = f.sweep ?? 0;
  const gray = f.gray ?? FUR;
  for (let k = 0; k < f.count; k++) {
    const a = ((k + (rand() - 0.5) * 0.5) / f.count) * TAU;
    if (f.skip?.(a)) continue;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const out = v(ca * f.rz, 0, sa * f.rx).normalize();
    const tan = v(-out.z, 0, out.x);
    // Each a little higher or lower than the next, so the rows don't read as tiers.
    const base = v(ca * f.rx * 1.02, f.y + (rand() - 0.5) * 0.12, z0 + sa * f.rz * 1.02);
    const w = ((TAU * (f.rx + f.rz)) / 2 / f.count) * (0.7 + rand() * 0.35);
    const l = f.len * (0.5 + rand() * 0.9);
    const b1 = base.clone().addScaledVector(tan, w / 2);
    const b2 = base.clone().addScaledVector(tan, -w / 2);
    const b3 = base.clone().addScaledVector(out, 0.06 + rand() * 0.04).add(v(0, 0.03, 0));
    const tip = base
      .clone()
      .add(v(0, -l, sweep * l))
      .addScaledVector(out, l * (spread + 0.2) * (0.6 + rand() * 0.7))
      .addScaledVector(tan, (rand() - 0.5) * w * 0.7);
    const centre = base.clone().addScaledVector(out, -0.15).add(v(0, -l * 0.3, 0));
    // Pale all through (the hair's undersides fall in shadow by themselves), a little paler at the roots.
    const g = gray * (0.94 + rand() * 0.14);
    const top = g * 1.05;
    const end = g * 0.86;
    const n = out.clone().multiplyScalar(0.85).add(v(0, 0.35, 0)).normalize();
    s.tri(b1, b2, tip, g, g, end, centre, n);
    s.tri(b2, b3, tip, g, top, end, centre, n);
    s.tri(b3, b1, tip, top, g, end, centre, n);
    s.tri(b1, b3, b2, g, top, g, centre, n);
  }
  return s.build();
}

interface YetiShapes {
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  jaw: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  forearm: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  foot: THREE.BufferGeometry;
}

const limb = (rings: Ring[], snow: number) => loft("y", rings, snow, 9);

/** Whether a bearing faces forward (towards +Z), within a half-angle. */
const front = (half: number) => (a: number) => Math.abs(wrap(a - Math.PI / 2)) < half;

/**
 * The yeti's shapes are built once and shared: by the yeti the walker meets, and by its own
 * arms when the walk is seen through its eyes. Whichever is disposed first lets them go;
 * the next to ask builds them again.
 */
let built: YetiShapes | null = null;
function yetiShapes(): YetiShapes {
  return (built ??= buildShapes());
}
function releaseShapes(shapes: YetiShapes): void {
  if (built !== shapes) return;
  for (const g of Object.values(shapes)) g.dispose();
  built = null;
}

function buildShapes(): YetiShapes {
  const rand = mulberry32(0x7e71);
  const f = FUR;
  // Torso, from the hump between the shoulders down to the pelvis (origin at the hips):
  // the back rounded over in a stoop, a deep chest thrust forward, a heavy gut, the
  // shoulders the widest part of it.
  const torso = mergeGeometries([
    shag(
      loft(
        "y",
        [
          [-0.15, 1.08, 0.12, 0.1, f],
          [-0.11, 1.01, 0.34, 0.26, f],
          [-0.04, 0.88, 0.47, 0.33, f],
          [0.04, 0.7, 0.45, 0.37, f],
          [0.07, 0.5, 0.4, 0.37, f],
          [0.08, 0.32, 0.36, 0.36, f],
          [0.05, 0.15, 0.32, 0.31, f],
          [0.0, 0.0, 0.33, 0.28, f],
          [-0.03, -0.12, 0.27, 0.22, f],
          [-0.03, -0.2, 0.12, 0.1, f]
        ],
        0.6,
        14
      ),
      rand,
      0.045
    ),
    // Shoulders humped with muscle where the arms hang from them.
    shag(paint(ellipsoid(0.17, 0.17, 0.19, 0.46, 0.86, -0.03), f, 0.6), rand, 0.04),
    shag(paint(ellipsoid(0.17, 0.17, 0.19, -0.46, 0.86, -0.03), f, 0.6), rand, 0.04),
    // Layer on layer of long hair: a cape over the shoulders, then the chest and back,
    // the belly, and a skirt over the haunches.
    // The hair lies close over the body, so its shape still shows; it hangs long only off the
    // shoulders, the flanks and the haunches.
    fringe(rand, { y: 1.0, z: -0.1, rx: 0.36, rz: 0.27, count: 18, len: 0.17, spread: 0.2, gray: f * 1.04 }),
    fringe(rand, { y: 0.84, z: -0.03, rx: 0.48, rz: 0.34, count: 24, len: 0.2, spread: 0.08 }),
    fringe(rand, { y: 0.6, z: 0.05, rx: 0.45, rz: 0.38, count: 24, len: 0.17, spread: 0.0 }),
    fringe(rand, { y: 0.38, z: 0.07, rx: 0.39, rz: 0.38, count: 22, len: 0.17, spread: 0.0 }),
    fringe(rand, { y: 0.14, z: 0.03, rx: 0.34, rz: 0.32, count: 22, len: 0.22, spread: 0.08 })
  ])!;

  // Head, from where it sits low and forward on the shoulders: a heavy skull rising to a
  // pointed crest swept back, a dark flat face set deep in a ruff of hair, a jutting
  // brow over two dull eyes, a broad flat nose.
  const head = mergeGeometries([
    shag(paint(ellipsoid(0.17, 0.19, 0.19, 0, 0.12, 0.0), f, 0.6), rand, 0.04),
    shag(paint(ellipsoid(0.1, 0.19, 0.15, 0, 0.29, -0.07, -0.45), f, 0.6), rand, 0.04),
    // Cheeks and jowls: fur framing the face on both sides.
    shag(paint(ellipsoid(0.09, 0.12, 0.1, 0.12, 0.06, 0.08), f, 0.4), rand, 0.04),
    shag(paint(ellipsoid(0.09, 0.12, 0.1, -0.12, 0.06, 0.08), f, 0.4), rand, 0.04),
    facet(paint(ellipsoid(0.115, 0.12, 0.06, 0, 0.07, 0.145), SKIN)),
    facet(paint(ellipsoid(0.125, 0.04, 0.05, 0, 0.155, 0.165, 0.15), SKIN * 1.1)),
    facet(paint(ellipsoid(0.045, 0.035, 0.035, 0, 0.085, 0.2), SKIN * 0.85)),
    facet(dye(paint(ellipsoid(0.02, 0.012, 0.01, 0.05, 0.12, 0.19), 0.66), EYE, EYE_GLOW)),
    facet(dye(paint(ellipsoid(0.02, 0.012, 0.01, -0.05, 0.12, 0.19), 0.66), EYE, EYE_GLOW)),
    // The mouth: black inside, for when the jaw drops.
    facet(dye(paint(ellipsoid(0.07, 0.045, 0.05, 0, 0.02, 0.14), 0.02), MAW)),
    // Long hair down the back of the head and the sides, the face left clear.
    fringe(rand, { y: 0.24, z: -0.02, rx: 0.17, rz: 0.17, count: 14, len: 0.14, spread: 0.2, sweep: -0.3, skip: front(0.75) }),
    fringe(rand, { y: 0.08, z: 0.0, rx: 0.2, rz: 0.19, count: 14, len: 0.13, spread: 0.15, skip: front(0.6) })
  ])!;
  const fang = (x: number) => {
    const g = new THREE.ConeGeometry(0.013, 0.045, 3);
    g.translate(x, 0.0, 0.165);
    return facet(dye(paint(g, 0.78), FANG));
  };
  const jaw = mergeGeometries([
    facet(paint(ellipsoid(0.09, 0.04, 0.095, 0, -0.025, 0.085), SKIN)),
    fang(0.042),
    fang(-0.042),
    // A beard under the chin.
    fringe(rand, { y: -0.03, z: 0.06, rx: 0.1, rz: 0.08, count: 9, len: 0.13, spread: 0.15, sweep: -0.2 })
  ])!;

  const upperArm = mergeGeometries([
    shag(
      limb(
        [
          [0, 0.1, 0.15, 0.15, f],
          [0.01, -0.08, 0.165, 0.17, f],
          [0.01, -0.3, 0.14, 0.14, f],
          [0, -0.5, 0.11, 0.115, f],
          [0, -UPPER_ARM - 0.03, 0.1, 0.1, f]
        ],
        0.5
      ),
      rand,
      0.035
    ),
    fringe(rand, { y: -0.12, rx: 0.17, rz: 0.17, count: 13, len: 0.15, spread: 0.12 }),
    fringe(rand, { y: -0.4, rx: 0.13, rz: 0.13, count: 12, len: 0.18, spread: 0.12, sweep: -0.15 })
  ])!;
  // Forearm and hand: long hair hanging off the forearm, then a dark, long-fingered hand
  // with the fingers half curled, and claws.
  const hand: THREE.BufferGeometry[] = [warm(facet(paint(ellipsoid(0.065, 0.1, 0.075, 0, -FOREARM - 0.07, 0.01), SKIN)), PALM_HEAT)];
  for (const [x, l] of [
    [-0.04, 0.12],
    [-0.013, 0.14],
    [0.013, 0.14],
    [0.04, 0.11]
  ]) {
    const a = v(x, -FOREARM - 0.14, 0.03);
    const b = v(x * 1.15, -FOREARM - 0.14 - l, 0.06);
    const c = b.clone().add(v(0, -0.05, 0.05));
    hand.push(warm(facet(paint(rod(a, b, 0.019, 0.015), SKIN)), PALM_HEAT));
    hand.push(warm(facet(paint(rod(b, c, 0.015, 0.01), SKIN)), PALM_HEAT * 0.8));
    hand.push(facet(dye(paint(rod(c, c.clone().add(v(0, -0.01, 0.03)), 0.01, 0.002), 0.5), CLAW)));
  }
  hand.push(warm(facet(paint(rod(v(0.05, -FOREARM - 0.06, 0.04), v(0.065, -FOREARM - 0.15, 0.09), 0.02, 0.012), SKIN)), PALM_HEAT));
  const forearm = mergeGeometries([
    shag(
      limb(
        [
          [0, 0.04, 0.11, 0.11, f],
          [0.01, -0.12, 0.14, 0.135, f],
          [0, -0.36, 0.1, 0.1, f],
          [0, -FOREARM + 0.04, 0.075, 0.08, f],
          [0, -FOREARM - 0.02, 0.065, 0.065, f]
        ],
        0.4
      ),
      rand,
      0.035
    ),
    // Long hair hanging off the forearms, the shagginess that shows most as they swing.
    fringe(rand, { y: -0.06, rx: 0.14, rz: 0.14, count: 13, len: 0.3, spread: 0.22, sweep: -0.2 }),
    fringe(rand, { y: -0.34, rx: 0.1, rz: 0.1, count: 12, len: 0.2, spread: 0.18 }),
    ...hand
  ])!;

  const thigh = mergeGeometries([
    shag(
      limb(
        [
          [0.02, 0.1, 0.19, 0.21, f],
          [0.03, -0.12, 0.19, 0.21, f],
          [0.01, -0.35, 0.15, 0.16, f],
          [0, -THIGH + 0.02, 0.12, 0.13, f],
          [0, -THIGH - 0.05, 0.11, 0.12, f]
        ],
        0.4
      ),
      rand,
      0.035
    ),
    fringe(rand, { y: -0.12, rx: 0.2, rz: 0.22, count: 15, len: 0.18, spread: 0.08 }),
    fringe(rand, { y: -0.36, rx: 0.16, rz: 0.17, count: 14, len: 0.17, spread: 0.08 })
  ])!;
  // Shin, the calf full behind, hair hanging over the ankle.
  const shin = mergeGeometries([
    shag(
      limb(
        [
          [0, 0.03, 0.12, 0.13, f],
          [-0.025, -0.12, 0.13, 0.15, f],
          [0, -0.32, 0.1, 0.11, f],
          [0, -SHIN + 0.04, 0.09, 0.1, f],
          [0, -SHIN - 0.02, 0.085, 0.095, f]
        ],
        0.3
      ),
      rand,
      0.035
    ),
    fringe(rand, { y: -0.12, rx: 0.14, rz: 0.15, count: 13, len: 0.15, spread: 0.06 }),
    fringe(rand, { y: -0.34, rx: 0.11, rz: 0.12, count: 13, len: 0.17, spread: 0.25 })
  ])!;
  // A great, flat foot, broad across the toes.
  const toes: THREE.BufferGeometry[] = [];
  for (let t = 0; t < 5; t++) {
    const x = (t - 2) * 0.042;
    toes.push(facet(paint(ellipsoid(0.024, 0.024, 0.035, x, -0.06, 0.24 - Math.abs(t - 2) * 0.015), SKIN * 1.2)));
  }
  const foot = mergeGeometries([
    facet(paint(ellipsoid(0.11, 0.055, 0.2, 0, -0.045, 0.08), SKIN * 1.3, 0.5)),
    ...toes,
    fringe(rand, { y: 0.02, z: 0.02, rx: 0.1, rz: 0.11, count: 10, len: 0.09, spread: 0.4 })
  ])!;
  return { torso, head, jaw, upperArm, forearm, thigh, shin, foot };
}

interface Arm {
  upper: THREE.Group;
  lower: THREE.Group;
  side: 1 | -1;
  /** Where the arm is swung to, lagging behind where the stride would put it. */
  swing: number;
}

interface Leg {
  upper: THREE.Group;
  lower: THREE.Group;
  ankle: THREE.Group;
  side: 1 | -1;
}

type State = "hidden" | "stalk" | "roar" | "chase" | "still" | "lift" | "preview";

/** Where the hands close, in a forearm's own frame: round the palm. */
const PALM = new THREE.Vector3(0, -FOREARM - 0.13, 0.04);
/** The middle of the face, in the head's own frame: between the eyes and the nose. */
const FACE = new THREE.Vector3(0, 0.1, 0.18);
/** The open mouth, in the head's own frame: just in front of the dark inside it. */
const MOUTH = new THREE.Vector3(0, 0.0, 0.2);

/** The berth the yeti needs past anything the walker would bump into. */
const berth = (c: Collider) => (c.walk > 0 ? c.walk + BODY : 0);

const lerp = THREE.MathUtils.lerp;

/**
 * The yeti: about two and a half metres of shaggy, stooped bulk, its long arms hanging
 * to its knees. It walks straight at the walker with heavy, bent-kneed strides, rears up
 * and roars when the story says so, then runs the walker down: quicker than a walk, a
 * little slower than a flat-out run.
 */
export class Yeti {
  readonly root = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly veil = { value: 1 };
  heading = 0;
  speed = 0;
  state: State = "hidden";
  /** Stalking, it walks at this pace, m/s. Set by the story. */
  pace = STALK;
  /** Set once each time a foot comes down: how hard, 0..1. Read and cleared by whoever plays the sound. */
  stomp = 0;
  /** Set the moment it roars. */
  roared = false;
  /** Caught: how far the walker has been lifted, 0 (seized) to 1 (held high overhead). Set by the story. */
  lift = 0;
  /** Caught: how wide the jaws are open for the walker, 0..1. Set by the story. */
  gape = 0;
  private shapes = yetiShapes();
  private material: THREE.MeshStandardMaterial;
  private hips = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private jaw = new THREE.Group();
  private arms: Arm[] = [];
  private legs: Leg[] = [];
  private phase = 0;
  private lastStep = 0;
  private stateTime = 0;
  private roarPose = 0;
  private roarLength = ROAR_TIME;
  private reach = 0;
  private time = 0;
  private stepSpeed = 0;
  private previewSpeed = 0;
  private want = 0;
  private steerIn = 0;
  private grad = new THREE.Vector2();
  private colliders: Collider[] = [];
  private tmpGrip = new THREE.Vector3();

  constructor() {
    const s = this.shapes;
    const m = (this.material = createCoatMaterial(this.veil, COAT));
    this.root.rotation.order = "YXZ";
    this.hips.position.y = HIP_Y;
    this.hips.rotation.order = "YXZ";
    this.root.add(this.hips);
    this.hips.add(this.torso);
    this.torso.rotation.order = "YXZ";
    this.torso.add(new THREE.Mesh(s.torso, m));
    this.head.position.set(0, 1.0, 0.18);
    this.head.scale.setScalar(1.22);
    this.head.add(new THREE.Mesh(s.head, m));
    this.jaw.position.set(0, 0.05, 0.06);
    this.jaw.add(new THREE.Mesh(s.jaw, m));
    this.head.add(this.jaw);
    this.torso.add(this.head);
    for (const side of [1, -1] as const) {
      const upper = new THREE.Group();
      upper.position.set(side * 0.5, 0.84, -0.02);
      upper.add(new THREE.Mesh(s.upperArm, m));
      const lower = new THREE.Group();
      lower.position.y = -UPPER_ARM;
      lower.add(new THREE.Mesh(s.forearm, m));
      upper.add(lower);
      this.torso.add(upper);
      this.arms.push({ upper, lower, side, swing: 0 });
      const thigh = new THREE.Group();
      thigh.position.set(side * 0.19, -0.05, 0);
      thigh.add(new THREE.Mesh(s.thigh, m));
      const knee = new THREE.Group();
      knee.position.y = -THIGH;
      knee.add(new THREE.Mesh(s.shin, m));
      const ankle = new THREE.Group();
      ankle.position.y = -SHIN;
      ankle.add(new THREE.Mesh(s.foot, m));
      knee.add(ankle);
      thigh.add(knee);
      this.hips.add(thigh);
      this.legs.push({ upper: thigh, lower: knee, ankle, side });
    }
    this.root.visible = false;
  }

  /**
   * Sets it walking at (x, z), facing a heading: there at once, whole, so only ever where
   * the fog hides it or out of view.
   */
  spawn(x: number, z: number, heading: number): void {
    this.position.set(x, 0, z);
    this.heading = heading;
    this.want = heading;
    this.pace = STALK;
    this.speed = STALK;
    this.stepSpeed = STALK;
    this.state = "stalk";
    this.stateTime = 0;
    this.steerIn = 0;
    this.roarPose = 0;
    this.reach = 0;
    this.veil.value = 0;
    this.roared = false;
    this.lift = 0;
    this.gape = 0;
    // Shown from its first update on, which is what stands it on the ground there.
    this.root.visible = false;
  }

  /** Stops, rears up and roars for `length` seconds; then it runs. */
  roar(length = ROAR_TIME): void {
    if (this.state !== "stalk") return;
    this.roarLength = length;
    this.state = "roar";
    this.stateTime = 0;
    this.roared = true;
  }

  /** Has the walker: stops, turns square to them and lifts them overhead (as far as `lift` says). */
  seize(): void {
    if (this.state === "hidden") return;
    this.state = "lift";
    this.stateTime = 0;
    this.lift = 0;
    this.gape = 0;
  }

  /** Where its two hands meet, in the world, as it stands this frame. */
  grip(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    const a = this.arms[0].lower.localToWorld(this.tmpGrip.copy(PALM));
    out.copy(a);
    const b = this.arms[1].lower.localToWorld(this.tmpGrip.copy(PALM));
    return out.add(b).multiplyScalar(0.5);
  }

  /** Its open mouth, in the world, as it stands this frame. */
  mouth(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.head.localToWorld(out.copy(MOUTH));
  }

  /** The middle of its face, in the world, as it stands this frame. */
  face(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.head.localToWorld(out.copy(FACE));
  }

  hide(): void {
    this.state = "hidden";
    this.root.visible = false;
    this.speed = 0;
  }

  /** Stops where it is (the walker got away). */
  halt(): void {
    if (this.state !== "hidden") this.state = "still";
  }

  /**
   * For looking the model over: stands it at a spot, facing a heading, its legs going
   * at a pace without it getting anywhere (a roar too, with `roar`).
   */
  preview(x: number, z: number, heading: number, pace: number, roar = false): void {
    this.position.set(x, 0, z);
    this.heading = heading;
    this.previewSpeed = pace;
    this.roarPose = roar ? 1 : 0;
    this.state = "preview";
    this.veil.value = 0;
    this.root.visible = true;
  }

  update(dt: number, target: THREE.Vector3, world: World, height: HeightFn): void {
    if (this.state === "hidden") return;
    this.time += dt;
    this.stateTime += dt;
    const p = this.position;
    const dist = Math.hypot(target.x - p.x, target.z - p.z);
    const toTarget = Math.atan2(target.x - p.x, target.z - p.z);

    if (this.state === "preview") {
      this.stepSpeed = this.previewSpeed;
      this.animate(dt, Infinity, this.heading, height);
      return;
    }

    // Caught: pulled up short, swinging square to the walker, feet planted.
    if (this.state === "lift") {
      const turn = 6 * dt;
      this.heading = wrap(this.heading + THREE.MathUtils.clamp(wrap(toTarget - this.heading), -turn, turn));
      this.speed = Math.max(0, this.speed - 9 * dt);
      p.x += Math.sin(this.heading) * this.speed * dt;
      p.z += Math.cos(this.heading) * this.speed * dt;
      this.stepSpeed += (this.speed - this.stepSpeed) * (1 - Math.exp(-dt * 8));
      this.animate(dt, dist, toTarget, height);
      return;
    }

    let goal = 0;
    if (this.state === "stalk") {
      goal = this.pace;
    } else if (this.state === "roar") {
      goal = 0;
      if (this.stateTime > this.roarLength) {
        this.state = "chase";
        this.stateTime = 0;
      }
    } else if (this.state === "chase") {
      // As much slower uphill as anyone is, and quicker down.
      heightGradient(height, p.x, p.z, this.grad);
      const uphill = this.grad.x * Math.sin(this.heading) + this.grad.y * Math.cos(this.heading);
      goal = CHASE * slopePace(uphill);
    }

    // Steer for the walker along whichever way is open between the trees.
    world.collidersNear(p.x, p.z, this.colliders);
    this.steerIn -= dt;
    if (this.steerIn <= 0) {
      this.steerIn = 0.12;
      let best = -Infinity;
      for (const off of HEADINGS) {
        if (Math.abs(off) > 2.2) continue;
        const h = toTarget + off;
        const free = freeDistance(p, Math.sin(h), Math.cos(h), this.colliders, LOOK, berth);
        const clear = free >= Math.min(LOOK, dist - 0.5);
        const score = (clear ? 1.2 : free / LOOK) + Math.cos(off) * 0.8 - (free < 1.2 ? 2 : 0);
        if (score > best) {
          best = score;
          this.want = h;
        }
      }
    }
    const turnRate = (this.state === "chase" ? 2.6 : 1.4) * dt;
    this.heading = wrap(this.heading + THREE.MathUtils.clamp(wrap(this.want - this.heading), -turnRate, turnRate));
    if (this.state === "roar" || this.state === "still") {
      this.heading = wrap(this.heading + THREE.MathUtils.clamp(wrap(toTarget - this.heading), -turnRate, turnRate));
    }
    const facing = Math.max(0, Math.cos(wrap(this.want - this.heading)));
    goal *= 0.4 + 0.6 * facing;
    if (this.state === "still") goal = 0;
    this.speed += THREE.MathUtils.clamp(goal - this.speed, -6 * dt, ACCEL * dt);

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
    this.animate(dt, dist, toTarget, height);
  }

  /** Puts it somewhere else on the ground at once (only ever unseen), heading for the walker. */
  teleport(x: number, z: number, target: THREE.Vector3): void {
    this.position.x = x;
    this.position.z = z;
    this.heading = Math.atan2(target.x - x, target.z - z);
    this.want = this.heading;
    this.steerIn = 0;
  }

  /**
   * A heavy, bent-kneed gait, more like a bear's or a great ape's walking upright than a
   * man's: the knees never lock, the hips roll and sway over each planted foot, the feet
   * come down flat and peel off at the toes, and the long arms swing from the shoulders a
   * beat behind the legs. Running, it drops lower and leans in, the arms pumping.
   */
  private animate(dt: number, dist: number, toTarget: number, height: HeightFn): void {
    const p = this.position;
    const run = THREE.MathUtils.smoothstep(this.stepSpeed, 1.8, 4.4);
    const move = Math.min(1, this.stepSpeed / 0.5);
    // Two steps a cycle: long slow strides walking, longer ones running.
    const cycle = lerp(1.9, 3.6, run);
    this.phase = (this.phase + (this.stepSpeed / cycle) * dt) % 1;
    const step = Math.floor(this.phase * 2);
    if (step !== this.lastStep) {
      this.lastStep = step;
      if (move > 0.3) this.stomp = 0.45 + 0.55 * run;
    }
    const a = this.phase * TAU;

    // The roar: rearing up, arms flung wide and high, head thrown back, jaw dropped.
    if (this.state !== "preview") {
      const roaring = this.state === "roar" ? 1 : 0;
      this.roarPose += (roaring - this.roarPose) * (1 - Math.exp(-dt * (roaring ? 7 : 4)));
    }
    const r = this.roarPose;
    // Close behind its quarry, the arms come up and forward to grab.
    const lifting = this.state === "lift";
    const grab = lifting ? 1 : this.state === "chase" ? 1 - THREE.MathUtils.smoothstep(dist, 2.5, 5.5) : 0;
    this.reach += (grab - this.reach) * (1 - Math.exp(-dt * (lifting ? 12 : 5)));
    const g = this.reach;
    // Lifting: straightening up and leaning back under the weight, arms going up overhead.
    const up = lifting ? this.lift : 0;
    const shake = Math.sin(this.time * 31) * 0.035 * r;
    const breathe = Math.sin(this.time * 1.6);

    // Torso: stooped walking, leaning hard into a run, rocking with the stride.
    const lean = lerp(lerp(lerp(0.28, 0.58, run), -0.12, r), -0.16, up) + breathe * 0.015 * (1 - move);
    this.torso.rotation.set(lean + Math.cos(a * 2) * 0.03 * move, -Math.sin(a) * lerp(0.12, 0.18, run) * move, Math.sin(a) * 0.04 * move);
    this.torso.scale.set(1 + breathe * 0.012, 1, 1 + breathe * 0.018);
    // Hips: low over bent knees, lower running; rising and falling with each step,
    // swaying over the planted foot and rolling with it.
    const bob = Math.cos(a * 2) * lerp(0.025, 0.06, run) * move;
    this.hips.position.set(Math.sin(a) * 0.035 * (1 - run) * move, HIP_Y - run * 0.09 + bob + r * 0.06, 0);
    this.hips.rotation.set(-run * 0.05, Math.sin(a) * 0.1 * move, -Math.sin(a) * 0.05 * move);

    for (const leg of this.legs) {
      const as = a + (leg.side > 0 ? 0 : Math.PI);
      // Forward of the hip when sin(as) > 0; swinging forward when cos(as) > 0.
      const fwd = Math.sin(as);
      const swinging = Math.max(0, Math.cos(as));
      const stride = lerp(0.34, 0.68, run) * move;
      // The thigh comes forward under the stoop (which already tips the hips forward).
      const thigh = -fwd * stride - lerp(0.08, 0.3, run) - r * 0.05;
      const knee = lerp(0.18, 0.38, run) + swinging * lerp(0.6, 1.25, run) * move + Math.max(0, fwd) * 0.08 * move;
      leg.upper.rotation.set(thigh, 0, leg.side * 0.05);
      leg.lower.rotation.x = knee;
      // Flat on the ground through the stance, toes peeling off as the leg swings through.
      const toeOff = Math.max(0, -fwd) * swinging * lerp(0.55, 0.85, run) * move;
      leg.ankle.rotation.x = -(thigh + knee + this.hips.rotation.x) + toeOff - 0.02;
    }

    for (const arm of this.arms) {
      const as = a + (arm.side > 0 ? 0 : Math.PI);
      // Opposite the leg on its side, a beat behind it, as a heavy hanging limb swings.
      const target = Math.sin(as - 0.45) * lerp(0.32, 0.8, run) * move;
      arm.swing += (target - arm.swing) * (1 - Math.exp(-dt * 10));
      // Hanging straight down, whatever the stoop, then swung.
      const hang = -lean * 0.9;
      const walkX = hang + arm.swing;
      // Held a little out from the bulk of the body, swinging clear of it.
      const walkZ = arm.side * (0.17 + run * 0.08) + Math.max(0, -arm.swing) * 0.04 * arm.side;
      const walkElbow = -(0.18 + run * 0.75) - Math.max(0, -arm.swing) * 0.3 - Math.max(0, arm.swing) * 0.15;
      let x = lerp(walkX, -2.35, r);
      let z = lerp(walkZ, arm.side * 0.75, r);
      let elbow = lerp(walkElbow, -0.55, r);
      x = lerp(x, -1.25 - lean + arm.swing * 0.2, g);
      z = lerp(z, arm.side * 0.25, g);
      elbow = lerp(elbow, -0.35, g);
      // Overhead, a little forward, the hands closed together round the walker.
      x = lerp(x, -2.55 - lean, up);
      z = lerp(z, -arm.side * 0.2, up);
      elbow = lerp(elbow, -0.4, up);
      arm.upper.rotation.set(x, 0, z);
      arm.lower.rotation.x = elbow;
    }

    // Head: carried level, looking ahead, whatever the body does; turned towards its quarry.
    const look = THREE.MathUtils.clamp(wrap(toTarget - this.heading), -0.8, 0.8);
    // Lifting, it looks up at what it holds, the jaw dropping.
    this.head.rotation.set(
      -this.torso.rotation.x * 0.85 + lerp(lerp(0.08, -0.5, r), -0.75, up) + shake - bob * 0.8,
      look * (1 - r) * (1 - up) - this.torso.rotation.y * 0.7,
      shake * 0.5
    );
    this.jaw.rotation.x = Math.max(0.55 * r, 0.6 * up, lifting ? 0.95 * this.gape : 0) + 0.12 * g + Math.max(0, Math.sin(this.time * 2.3)) * 0.05;

    // Feet sink into the snow.
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const hf = height(p.x + fx * 0.4, p.z + fz * 0.4);
    const hb = height(p.x - fx * 0.4, p.z - fz * 0.4);
    p.y = (hf + hb) / 2 - 0.12;
    this.root.position.copy(p);
    this.root.rotation.set(-Math.atan2(hf - hb, 0.8) * 0.5, this.heading, 0);
    this.root.visible = this.veil.value < 0.999;
  }

  dispose(): void {
    releaseShapes(this.shapes);
    this.material.dispose();
  }
}

/** Its shoulders, from its eyes, in the frame of its body (X to its left, Y up, Z ahead). */
const SHOULDER = new THREE.Vector3(0.5, -0.6, -0.12);
/** From shoulder to elbow, and from elbow to the middle of the palm. */
const REACH_UPPER = UPPER_ARM;
const REACH_LOWER = Math.hypot(FOREARM + 0.13, 0.04);

/** What the arms are doing, for Paws.update(). Every share is 0..1. */
export interface PawsPose {
  /** Flung up and wide, as it roars. */
  roar: number;
  /** How fast it is going, as a share of a flat-out charge: the arms swing, then pump. */
  run: number;
  /** Reaching out ahead for what it is about to catch. */
  reach: number;
  /** Where the two palms close, in the world (held round something), and how much they are there. */
  grip?: [THREE.Vector3, THREE.Vector3];
  hold: number;
}

/**
 * The yeti's own arms, as it sees them: the same long, shaggy arms, swinging below the
 * view as it walks, pumping up into the bottom of it as it charges, flung up and wide at
 * either side as it roars, and reaching out, closing round what it catches. Each arm is
 * bent to put the palm where the pose wants it, the elbow out and down.
 */
export class Paws {
  readonly root = new THREE.Group();
  private shapes = yetiShapes();
  private material: THREE.MeshStandardMaterial;
  /** Each arm, where its palm is asked to go, and where it got to (in the body's frame). */
  private arms: { upper: THREE.Group; lower: THREE.Group; side: 1 | -1; hand: THREE.Vector3; palm: THREE.Vector3 }[] = [];
  private phase = 0;
  private time = 0;
  private settled = false;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private t = new THREE.Vector3();
  private s = new THREE.Vector3();
  private e = new THREE.Vector3();
  private x = new THREE.Vector3();
  private y = new THREE.Vector3();
  private z = new THREE.Vector3();
  private u = new THREE.Vector3();
  private f = new THREE.Vector3();
  private pole = new THREE.Vector3();

  constructor() {
    const s = this.shapes;
    this.material = createCoatMaterial({ value: 0 }, COAT, ARM_WARMTH);
    for (const side of [1, -1] as const) {
      const upper = new THREE.Group();
      upper.position.set(SHOULDER.x * side, SHOULDER.y, SHOULDER.z);
      upper.add(new THREE.Mesh(s.upperArm, this.material));
      const lower = new THREE.Group();
      lower.position.y = -UPPER_ARM;
      lower.add(new THREE.Mesh(s.forearm, this.material));
      upper.add(lower);
      this.root.add(upper);
      this.arms.push({ upper, lower, side, hand: new THREE.Vector3(), palm: new THREE.Vector3() });
    }
    this.root.visible = false;
  }

  show(on: boolean): void {
    this.root.visible = on;
    this.settled = false;
  }

  /** Follows the eyes at `eye`, the body turned to `yaw` (the walker's), in the pose given. */
  update(dt: number, eye: THREE.Vector3, yaw: number, pose: PawsPose): void {
    this.time += dt;
    // Two steps a cycle, quicker the faster it goes.
    this.phase = (this.phase + dt * (0.35 + pose.run * 0.85)) % 1;
    this.root.position.copy(eye);
    // Its front is +Z of its own frame; the eyes look down -Z.
    this.root.rotation.set(0, yaw + Math.PI, 0);
    this.root.updateMatrixWorld(true);
    const a = this.phase * TAU;
    for (const arm of this.arms) {
      const sd = arm.side;
      const w = Math.sin(a + (sd > 0 ? 0 : Math.PI));
      const t = this.t;
      // Hanging, swinging a little: out of sight below the view.
      t.set(sd * 0.6, -1.5 + Math.max(0, w) * 0.15 * pose.run, 0.15 + w * 0.3);
      // Charging, the arms pump up into the bottom of the view, one and then the other.
      const pump = THREE.MathUtils.smoothstep(pose.run, 0.35, 0.8);
      t.lerp(this.s.set(sd * 0.48, -0.78 + w * 0.24, 0.5 + w * 0.42), pump);
      t.lerp(this.s.set(sd * 0.3, -0.5 + Math.sin(this.time * 6 + sd) * 0.04, 1.15), pose.reach);
      // Roaring: flung up and out at either side, the claws spread, shaking.
      t.lerp(this.s.set(sd * 0.64, 0.28 + Math.sin(this.time * 23 + sd) * 0.03, 0.86), pose.roar);
      if (pose.grip && pose.hold > 0) t.lerp(this.root.worldToLocal(this.s.copy(pose.grip[sd > 0 ? 0 : 1])), pose.hold);
      if (!this.settled) arm.hand.copy(t);
      else arm.hand.lerp(t, 1 - Math.exp(-dt * (pose.hold > 0 ? 20 : 9)));
      // Elbows out to the side and down, and back a little.
      this.pole.set(sd * 0.7, -0.6, -0.4).lerp(this.e.set(sd * 0.8, -0.5, 0.2), pose.roar).normalize();
      this.bend(arm, arm.hand);
    }
    this.settled = true;
  }

  /** Halfway between its two palms as they are this frame (as far as the arms reach), in the world. */
  palms(out: THREE.Vector3): THREE.Vector3 {
    out.addVectors(this.arms[0].palm, this.arms[1].palm).multiplyScalar(0.5);
    return this.root.localToWorld(out);
  }

  /** Bends an arm (two bones, the elbow towards the pole) to put its palm as near a point in its body's frame as it reaches. */
  private bend(arm: { upper: THREE.Group; lower: THREE.Group; side: 1 | -1; palm: THREE.Vector3 }, target: THREE.Vector3): void {
    const s = arm.upper.position;
    const dir = this.u.subVectors(target, s);
    const d = THREE.MathUtils.clamp(dir.length(), 0.3, REACH_UPPER + REACH_LOWER - 0.02);
    dir.normalize();
    const cosA = THREE.MathUtils.clamp((REACH_UPPER ** 2 + d * d - REACH_LOWER ** 2) / (2 * REACH_UPPER * d), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const perp = this.pole.addScaledVector(dir, -this.pole.dot(dir));
    if (perp.lengthSq() < 1e-6) perp.set(0, -1, 0);
    perp.normalize();
    // The elbow, and from it the hand.
    const elbow = this.e.copy(s).addScaledVector(dir, cosA * REACH_UPPER).addScaledVector(perp, sinA * REACH_UPPER);
    const hand = this.t.copy(s).addScaledVector(dir, d);
    arm.palm.copy(hand);
    const up = this.x.subVectors(elbow, s).normalize();
    const fore = this.f.subVectors(hand, elbow).normalize();
    // Each bone hangs along its own -Y and bends about its own X, the forearm towards +Z.
    const z = this.z.copy(fore).addScaledVector(up, -fore.dot(up));
    if (z.lengthSq() < 1e-6) z.copy(perp).negate();
    z.normalize();
    const y = this.y.copy(up).negate();
    const x = this.s.crossVectors(y, z);
    arm.upper.quaternion.setFromRotationMatrix(this.m.makeBasis(x, y, z));
    const y2 = this.y.copy(fore).negate();
    const z2 = this.z.crossVectors(x, y2);
    this.q2.setFromRotationMatrix(this.m.makeBasis(x, y2, z2));
    arm.lower.quaternion.copy(this.q.copy(arm.upper.quaternion).invert().multiply(this.q2));
  }

  dispose(): void {
    releaseShapes(this.shapes);
    this.material.dispose();
  }
}
