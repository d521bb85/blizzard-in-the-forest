import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { injectBlizzardFog } from "../render/fog";
import { injectRetro } from "../render/retro";
import { mulberry32 } from "../lib/noise";
import { lin } from "../lib/math";
import type { Collider } from "../world/collider";

/** What is carved into the board, line by line (the page shows the same words). */
export const SIGN_LINES = ["TREAD SOFTLY IN THESE WOODS,", "AND SOFTER STILL WHEN", "THE SNOW BEGINS TO HOWL."];

/** The board's width and height, in metres. */
export const BOARD_W = 1.6;
export const BOARD_H = 0.7;
/** Height of the board's centre above the snow. */
export const BOARD_Y = 1.15;
/** The board hangs crooked: turned this much about its own centre. */
const BOARD_TILT = -0.06;
const BOARD_D = 0.05;
/** The board's texture, in texels: coarse, but the words stay sharp from a few metres off. */
const TEX_W = 400;
const TEX_H = 176;
/** The pixel font at twice its native size, and the distance between lines. */
const FONT_PX = 37.3333;
const LINE_GAP = 50;
/** The gaps between the three planks, in texels from the top: one between each pair of lines. */
const SEAMS = [63, 113];
/** The stake's kinks from deep under the snow to its top, as x, y; it crosses the snow at x = 0. */
const STAKE: [number, number][] = [
  [0.12, -1.15],
  [-0.06, 0.56],
  [0.05, 1.2],
  [0.0, 1.72]
];
/** The stake stands behind the board. */
const STAKE_Z = -0.07;
/** How long the board waits for its font before it is painted without it, in milliseconds. */
const FONT_WAIT = 3000;
/** The walker and the yeti are kept off the whole board by a row of circles this far apart. */
const BLOCK_STEP = 0.24;
const BLOCK_WALK = 0.1;
const BLOCK_R = 0.2;

const HW = BOARD_W / 2;
const HH = BOARD_H / 2;
const SEAM_Y = SEAMS.map((t) => HH - t * (BOARD_H / TEX_H));

/**
 * The board's outline about its centre: the lower corner on the right broken off, a nick
 * out of the top, the left end split along a seam and the planks below it a little short.
 */
const OUTLINE: [number, number][] = [
  [-HW + 0.03, -HH],
  [0.58, -HH],
  [0.66, -0.29],
  [0.74, -0.27],
  [HW, -0.18],
  [HW, HH],
  [0.35, HH],
  [0.32, HH - 0.03],
  [0.28, HH],
  [-HW, HH],
  [-HW, SEAM_Y[0] + 0.017],
  [-HW + 0.16, SEAM_Y[0]],
  [-HW + 0.01, SEAM_Y[0] - 0.02],
  [-HW + 0.01, SEAM_Y[1]],
  [-HW + 0.03, SEAM_Y[1]]
];

/** Gives a shape flat greys: `snow` on its top-facing faces, `gray` elsewhere. */
function shade(g: THREE.BufferGeometry, gray: number, snow: number): THREE.BufferGeometry {
  const flat = g.index ? g.toNonIndexed() : g;
  flat.deleteAttribute("uv");
  const n = flat.attributes.normal as THREE.BufferAttribute;
  const colors = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const c = lin(n.getY(i) > 0.7 ? snow : gray);
    colors.set([c, c, c], i * 3);
  }
  flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return flat;
}

/** A box with a flat grey and, on its top-facing faces, a dusting of snow. */
function box(w: number, h: number, d: number, x: number, y: number, z: number, gray: number, snow: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return shade(g, gray, snow);
}

/** One length of the stake between two kinks, run a little past each so the joints close. */
function length(a: [number, number], b: [number, number], thick: number, gray: number, snow: number): THREE.BufferGeometry {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const g = new THREE.BoxGeometry(thick, Math.hypot(dx, dy) + 0.05, thick);
  g.rotateZ(-Math.atan2(dx, dy));
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, STAKE_Z);
  return shade(g, gray, snow);
}

function outline(): THREE.Shape {
  return new THREE.Shape(OUTLINE.map(([x, y]) => new THREE.Vector2(x, y)));
}

/** Hangs a part made about the board's centre in its place: crooked, at the board's height. */
function hang(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.rotateZ(BOARD_TILT);
  g.translate(0, BOARD_Y, 0);
  return g;
}

/**
 * The board's face: three weathered planks with grain, scratched, gouged and cracked,
 * and the words cut into them, dark in the grooves with a lighter lip below, as a knife
 * leaves them. The damage keeps off the letters.
 */
function paintBoard(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d")!;
  const rand = mulberry32(0x5167);

  // Letters drawn once into a mask: the damage is kept clear of it, then the words are cut.
  const mask = document.createElement("canvas");
  mask.width = TEX_W;
  mask.height = TEX_H;
  const m = mask.getContext("2d", { willReadFrequently: true })!;
  m.fillStyle = "#fff";
  m.textAlign = "center";
  m.textBaseline = "middle";
  m.font = `${FONT_PX}px "Jersey 10", monospace`;
  // Squeezed a little sideways if the longest line would run off the board.
  const widest = Math.max(...SIGN_LINES.map((line) => m.measureText(line).width));
  const squeeze = Math.min(1, (TEX_W - 28) / widest);
  m.setTransform(squeeze, 0, 0, 1, (TEX_W / 2) * (1 - squeeze), 0);
  SIGN_LINES.forEach((line, i) => m.fillText(line, TEX_W / 2, TEX_H / 2 + (i - (SIGN_LINES.length - 1) / 2) * LINE_GAP));
  const cut = m.getImageData(0, 0, TEX_W, TEX_H).data;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < TEX_W && y < TEX_H && cut[(y * TEX_W + x) * 4 + 3] > 110;
  const lettered = (x: number, y: number) => {
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) if (on(x + i, y + j)) return true;
    return false;
  };

  const v = new Float32Array(TEX_W * TEX_H);
  const knots = [
    [70, 12],
    [318, 70],
    [150, 160]
  ];
  for (let y = 0; y < TEX_H; y++) {
    const plank = y < SEAMS[0] ? 0 : y < SEAMS[1] ? 1 : 2;
    const base = [198, 212, 190][plank];
    const [kx, ky] = knots[plank];
    for (let x = 0; x < TEX_W; x++) {
      // Grain: long streaks along the plank, a knot here and there.
      const streak = Math.sin(y * 1.1 + Math.sin(x * 0.03 + plank * 3) * 2.2) * 9;
      const knot = Math.max(0, 1 - Math.hypot(x - kx, (y - ky) * 2.2) / 12) * -30;
      let b = base + streak + knot + (rand() - 0.5) * 14;
      // The gaps between the planks, and the board's edges worn darker.
      if (y === SEAMS[0] || y === SEAMS[0] + 1 || y === SEAMS[1] || y === SEAMS[1] + 1) b = 30;
      else if (y < 2 || y >= TEX_H - 2 || x < 2 || x >= TEX_W - 2) b *= 0.7;
      v[y * TEX_W + x] = b;
    }
  }

  const mark = (x: number, y: number, k: number) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= TEX_W || y >= TEX_H || lettered(x, y)) return;
    v[y * TEX_W + x] *= k;
  };
  /** A straight mark `thick` texels deep, wandering by up to `wobble` texels. */
  const stroke = (x0: number, y0: number, x1: number, y1: number, k: number, thick = 1, wobble = 0) => {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1));
    let off = 0;
    for (let i = 0; i <= n; i++) {
      off = Math.max(-wobble, Math.min(wobble, off + (rand() - 0.5) * wobble));
      const x = x0 + ((x1 - x0) * i) / n;
      const y = y0 + ((y1 - y0) * i) / n + off;
      for (let t = 0; t < thick; t++) mark(x, y + t, k);
    }
  };
  // Scratches: thin, slanting, some pale where the grey has been scraped back to wood.
  for (let i = 0; i < 28; i++) {
    const x = rand() * TEX_W;
    const y = rand() * TEX_H;
    const slope = (0.25 + rand() * 0.9) * (rand() < 0.5 ? -1 : 1);
    const len = 10 + rand() * 46;
    stroke(x, y, x + len, y + len * slope * 0.5, rand() < 0.45 ? 1.18 : 0.7);
  }
  // Gouges in the margins: a dark scoop with a pale lip under it.
  for (const [x, y, len] of [
    [30, 12, 18],
    [180, 163, 16],
    [246, 9, 12],
    [372, 62, 10],
    [16, 140, 9]
  ]) {
    stroke(x, y, x + len, y + 3, 0.42, 3, 1);
    stroke(x + 1, y + 3, x + len, y + 6, 1.16);
  }
  // Cracks along the grain: on from the split end, in from the nick, the broken corner and the right end.
  const crack = (points: number[][]) => {
    for (let i = 1; i < points.length; i++) stroke(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], 0.3, 1, 1.5);
  };
  crack([[0, 59], [40, 62], [96, 60], [128, 61]]);
  crack([[282, 0], [276, 9], [250, 17], [214, 19]]);
  crack([[352, 172], [330, 160], [286, 157], [262, 159]]);
  crack([[399, 110], [372, 106], [340, 108]]);
  crack([[399, 24], [384, 21], [366, 22]]);
  crack([[8, 118], [40, 121], [58, 119]]);
  // Two nail heads over the stake, between the lines.
  for (const [x, y] of [
    [198, 58],
    [203, 118]
  ]) {
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) mark(x + i, y + j, 0.3);
    mark(x, y + 3, 1.15);
    mark(x + 1, y + 3, 1.15);
  }

  const img = ctx.createImageData(TEX_W, TEX_H);
  for (let y = 0; y < TEX_H; y++) {
    for (let x = 0; x < TEX_W; x++) {
      // The cut: a groove with a pale lip below it.
      const k = on(x, y) ? 0.1 : on(x, y - 1) || on(x, y - 2) ? 1.22 : 1;
      const b = Math.min(255, v[y * TEX_W + x] * k);
      const i = (y * TEX_W + x) * 4;
      img.data[i] = b;
      img.data[i + 1] = b * 0.97;
      img.data[i + 2] = b * 0.92;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** The pixel font, or a few seconds' wait for it: without it the words are cut in a monospace face. */
async function fontLoaded(): Promise<void> {
  try {
    await Promise.race([document.fonts?.load('20px "Jersey 10"'), new Promise((resolve) => setTimeout(resolve, FONT_WAIT))]);
  } catch {
    // The fallback face will do.
  }
}

/**
 * A weathered signpost: one crooked stake, kinked twice and leaning, with a broken board
 * of three planks nailed askew to it, snow on every top edge. Its front (local +Z)
 * carries the carved words; the board's centre stays over `position`.
 */
export class Signpost {
  readonly group = new THREE.Group();
  readonly position = new THREE.Vector3();
  /** Which way the board faces, as a unit vector in x, z. */
  readonly facing = new THREE.Vector2(0, 1);
  /**
   * Resolves once the board's face is painted. Its texture is part of the material from the
   * start, so the shader built while loading is the one the sign is drawn with: nothing is
   * left to build on the frame it first comes into view.
   */
  readonly ready: Promise<void>;
  private texture: THREE.CanvasTexture;
  private faceMaterial: THREE.MeshStandardMaterial;
  private wood: THREE.BufferGeometry;
  private face: THREE.ShapeGeometry;

  constructor(woodMaterial: THREE.Material) {
    const canvas = document.createElement("canvas");
    canvas.width = TEX_W;
    canvas.height = TEX_H;
    const tex = (this.texture = new THREE.CanvasTexture(canvas));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    this.faceMaterial = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, color: 0xffffff, map: tex });
    // A board that cannot be painted (no 2D canvas, pixels not readable) stays blank: the walk goes on without the words.
    this.ready = fontLoaded()
      .then(() => {
        paintBoard(canvas);
        tex.needsUpdate = true;
      })
      .catch((err) => console.warn("The signpost's board could not be painted", err));
    const board = new THREE.ExtrudeGeometry(outline(), { depth: BOARD_D, bevelEnabled: false });
    board.translate(0, 0, -BOARD_D / 2);
    const top = HH + 0.02;
    const [a, b, c, d] = STAKE;
    this.wood = mergeGeometries([
      // The stake runs well down into the snow, so a slope never shows it standing on air.
      length(a, b, 0.115, 0.25, 0.25),
      length(b, c, 0.105, 0.29, 0.29),
      length(c, d, 0.095, 0.27, 0.9),
      hang(shade(board, 0.44, 0.9)),
      // Snow along the board's top, parted at the nick, and capping the stake.
      hang(box(1.05, 0.06, 0.07, -0.26, top, 0, 0.92, 0.95)),
      hang(box(0.4, 0.05, 0.07, 0.58, top - 0.005, 0, 0.92, 0.95)),
      box(0.13, 0.05, 0.13, d[0], d[1] + 0.035, STAKE_Z, 0.9, 0.95),
      drift()
    ])!;
    const wood = new THREE.Mesh(this.wood, woodMaterial);
    // The face follows the same broken outline, the texture laid over the whole board.
    this.face = new THREE.ShapeGeometry(outline());
    const p = this.face.attributes.position as THREE.BufferAttribute;
    const uv = this.face.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + HW) / BOARD_W, (p.getY(i) + HH) / BOARD_H);
    this.face.translate(0, 0, BOARD_D / 2 + 0.002);
    hang(this.face);
    const face = new THREE.Mesh(this.face, this.faceMaterial);
    this.faceMaterial.onBeforeCompile = (shader) => {
      injectBlizzardFog(shader);
      // In colour: weathered, cream-grey wood, the cut letters and the cracks a dark brown.
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        {
          const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
          float lum = dot(diffuseColor.rgb, LUMA);
          vec3 hue = mix(vec3(0.05, 0.022, 0.012), vec3(0.58, 0.43, 0.25), smoothstep(0.15, 0.5, pow(lum, 1.0 / 2.2)));
          diffuseColor.rgb = mix(diffuseColor.rgb, hue * (lum / dot(hue, LUMA)), uColour);
        }`
      );
      injectRetro(shader);
    };
    this.group.add(wood, face);
    this.group.visible = false;
  }

  /**
   * Stands the sign at a point, its board facing towards (fx, fz); `ground` gives the
   * snow's height where the stake goes in.
   */
  place(x: number, z: number, fx: number, fz: number, ground: (x: number, z: number) => number): void {
    this.facing.set(fx, fz).normalize();
    const y = ground(x, z);
    this.position.set(x, y, z);
    this.group.position.set(x, y - 0.03, z);
    this.group.rotation.set(0, Math.atan2(this.facing.x, this.facing.y), 0);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  /** The stake and the whole width of the board, for the walker and the yeti to keep out of. */
  colliders(): Collider[] {
    const out: Collider[] = [];
    const rx = this.facing.y;
    const rz = -this.facing.x;
    const n = Math.round((BOARD_W - 2 * BLOCK_WALK) / BLOCK_STEP);
    for (let i = 0; i <= n; i++) {
      const s = (i - n / 2) * BLOCK_STEP;
      out.push({ x: this.position.x + rx * s, z: this.position.z + rz * s, r: BLOCK_R, walk: BLOCK_WALK });
    }
    return out;
  }

  dispose(): void {
    this.wood.dispose();
    this.face.dispose();
    this.texture.dispose();
    this.faceMaterial.dispose();
  }
}

/** A little snow heaped round the foot of the stake. */
function drift(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  g.scale(0.36, 0.17, 0.32);
  g.translate(0, -0.04, STAKE_Z);
  return shade(g, 0.92, 0.92);
}
