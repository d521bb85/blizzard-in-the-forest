/**
 * The pointer, drawn in the game's own big square pixels (two screen pixels to each): white
 * with a black edge, so it shows on the gray of the fog and the black of the end screens alike.
 *
 * - An eye while looking about: standing still, or with the walk out of the player's hands (a
 *   scene playing out, the head turned to something, an end screen up). Now and then it blinks.
 * - A pair of felt boots in galoshes, seen from the side, while walking: standing together while
 *   the walker stands, stepping in time with the walker's own footsteps while it moves.
 * - A snowy fir tree leaning like an arrow, its tip the point, everywhere off the scene: over the name, the links and
 *   buttons, and while the forest loads.
 *
 * Every image stays within 32 by 32 CSS pixels: Chrome falls back to its own pointer for
 * anything larger near the edge of the window, and steering takes the pointer to the edges.
 */

/** Screen pixels to each of the cursor's pixels, as in the page's pixel type. */
const PIXEL = 2;
/** 'w' white, 'g' the shaded side, 'd' deep shade, 'k' black. */
const COLOURS: Record<string, [number, number, number]> = {
  w: [0xff, 0xff, 0xff],
  g: [0xb0, 0xb0, 0xb0],
  d: [0x58, 0x58, 0x58],
  k: [0x08, 0x08, 0x08]
};
const css = (v: string) => `rgb(${COLOURS[v].join(" ")})`;

/**
 * The shapes, in COLOURS' letters and '.' for clear. Each gets a black edge one pixel wide all
 * round (corners too), so the masks leave a pixel free on every side.
 */
const EYE_OPEN = [
  "....wwwww....",
  "..wwwkkkwww..",
  ".wwwkkwkkwww.",
  "wwwwkkkkkwwww",
  ".wwwkkkkkwww.",
  "..wwwkkkwww..",
  "....wwwww...."
];
const EYE_HALF = [
  ".............",
  ".............",
  "kkkkkkkkkkkkk",
  "wwwwkkkkkwwww",
  ".wwwkkkkkwww.",
  "..wwwkkkwww..",
  "....wwwww...."
];
const EYE_SHUT = [
  ".............",
  ".............",
  ".............",
  "ww.........ww",
  "..ww.....ww..",
  "....wwwww....",
  "............."
];

/**
 * One felt boot from the side, its toe to the right, in a black galosh: lit from the left, its
 * far side in shade. The pair is this one in front and the same, darker, a little behind it.
 */
const BOOT = [
  "wwwg....",
  "wwwg....",
  "wwwg....",
  "wwwg....",
  "wwwg....",
  "wwwg....",
  "wwwwg...",
  "wwwwwwg.",
  "wwwwwwwg",
  "kkkkkkkk",
  ".kkkkkk."
];
const BACK_BOOT = BOOT.map((r) => r.replaceAll("g", "d").replaceAll("w", "g"));
/** The pair's picture, in pixels with the edges: room for either boot to lift. */
const PAIR = 16;
/** How far a boot is lifted, and carried forward, in a step. */
const LIFT = 2;

/** A snowy fir leaning like an arrow, its tip the point: three tiers, lit from the left. */
const FIR = [
  ".w..........",
  ".wg.........",
  ".wggg.......",
  "wwwg........",
  "..wgg.......",
  "..wwggg.....",
  "..wwggggg...",
  "wwwwwgg.....",
  "...wwggg....",
  "...wwwgggg..",
  "..wwwwgggggg",
  ".wwwwwgggg..",
  "......dd....",
  "......dd...."
];

/** The pair of boots, the front one or the back one lifted mid-step, or both on the snow. */
function boots(lifted: "front" | "back" | null): string[][] {
  const grid = Array.from({ length: PAIR }, () => Array<string>(PAIR).fill("."));
  const draw = (mask: string[], x: number, y: number) =>
    outlined(mask).forEach((row, r) =>
      row.forEach((v, c) => {
        if (v !== ".") grid[y + r][x + c] = v;
      })
    );
  // Both stand on the bottom edge; the back one a little behind and further off.
  const ground = PAIR - (BOOT.length + 2);
  draw(BACK_BOOT, lifted === "back" ? 5 : 4, ground - 1 - (lifted === "back" ? LIFT : 0));
  draw(BOOT, lifted === "front" ? 1 : 0, ground - (lifted === "front" ? LIFT : 0));
  return grid;
}

/** The shape with its black edge: one pixel bigger on every side. */
function outlined(mask: string[]): string[][] {
  const h = mask.length + 2;
  const w = Math.max(...mask.map((r) => r.length)) + 2;
  const at = (r: number, c: number) => mask[r - 1]?.[c - 1] ?? ".";
  const grid: string[][] = [];
  for (let r = 0; r < h; r++) {
    const row: string[] = [];
    for (let c = 0; c < w; c++) {
      let v = at(r, c);
      if (v === ".") {
        for (let dr = -1; dr <= 1 && v === "."; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (at(r + dr, c + dc) !== ".") {
              v = "k";
              break;
            }
          }
        }
      }
      row.push(v);
    }
    grid.push(row);
  }
  return grid;
}

/**
 * The shape as a PNG, each of its pixels `scale` image pixels square; or "" where the canvas
 * can't be read back as drawn (anti-fingerprinting hands back blank or noise instead).
 */
function png(grid: string[][], scale: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = grid[0].length * scale;
  canvas.height = grid.length * scale;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "";
  grid.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v === ".") return;
      ctx.fillStyle = css(v);
      ctx.fillRect(c * scale, r * scale, scale, scale);
    })
  );
  // Every pixel must read back as drawn: clear, white or black.
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 0; i < data.length; i += 4) {
    const v = grid[Math.floor(i / 4 / canvas.width / scale)][Math.floor(((i / 4) % canvas.width) / scale)];
    const ok = v === "." ? data[i + 3] === 0 : data[i + 3] === 255 && data[i] === COLOURS[v][0];
    if (!ok) return "";
  }
  return canvas.toDataURL("image/png");
}

/** The shape as an SVG, its pixels `scale` CSS pixels square: sharp anywhere, and nothing to read back. */
function svg(grid: string[][], scale: number): string {
  const w = grid[0].length;
  const h = grid.length;
  let rects = "";
  grid.forEach((row, r) => {
    // One rectangle for each run of the same colour along a row.
    for (let c = 0; c < w; ) {
      const v = row[c];
      let end = c + 1;
      while (end < w && row[end] === v) end++;
      if (v !== ".") rects += `<rect x="${c}" y="${r}" width="${end - c}" height="1" fill="${css(v)}"/>`;
      c = end;
    }
  });
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${rects}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(doc)}`;
}

/** Whichever of image-set's spellings this browser takes for a cursor, if either. */
function imageSet(): string | null {
  if (typeof CSS === "undefined" || !CSS.supports) return null;
  for (const fn of ["image-set", "-webkit-image-set"]) {
    if (CSS.supports("cursor", `${fn}(url("a.png") 1x, url("b.png") 2x) 1 1, auto`)) return fn;
  }
  return null;
}

/**
 * A cursor value for the shape: sharp on high-density screens where the browser can be told
 * which image is which, else the plain one. The hotspot is in CSS pixels; `fallback` is the
 * browser's own pointer for when the image can't be used.
 */
function cursor(grid: string[][], hot: [number, number] | "centre", fallback: string, set: string | null, urls: string[]): string {
  const [x, y] = hot === "centre" ? [(grid[0].length * PIXEL) / 2, (grid.length * PIXEL) / 2] : hot;
  const one = png(grid, PIXEL);
  const two = one && set ? png(grid, PIXEL * 2) : "";
  let image: string;
  if (one && two) {
    image = `${set}(url("${one}") 1x, url("${two}") 2x)`;
    urls.push(one, two);
  } else {
    const url = one || svg(grid, PIXEL);
    image = `url("${url}")`;
    urls.push(url);
  }
  return `${image} ${Math.round(x)} ${Math.round(y)}, ${fallback}`;
}

/** Each blink: half shut, shut, half open again (ms). */
const BLINK = [
  { eye: "half", ms: 50 },
  { eye: "shut", ms: 90 },
  { eye: "half", ms: 60 }
] as const;
/** Open this long between blinks (ms), and sometimes a second blink straight after. */
const BLINK_GAP_MIN = 2600;
const BLINK_GAP_MAX = 6000;
const DOUBLE_BLINK = 0.2;
/** Just landed, both boots are on the snow for this much of each step before the other lifts. */
const PLANTED = 0.25;

type Eye = "open" | "half" | "shut";

export class Cursor {
  private readonly values: Record<string, string>;
  private shown = "";
  private eye: Eye = "open";
  private look = true;
  private feet = "boots";
  private blinkTimer = 0;
  /** No frame from the game yet: the forest is still loading (or never will), and the scene shows the tree too. */
  private started = false;
  /**
   * Every picture, loaded up front and kept: Firefox shows its own pointer instead of one
   * still loading, which would be the whole of a first blink or a first step.
   */
  private readonly loaded: HTMLImageElement[] = [];

  constructor(private readonly root: HTMLElement = document.documentElement) {
    const set = imageSet();
    const urls: string[] = [];
    this.values = {
      "eye-open": cursor(outlined(EYE_OPEN), "centre", "default", set, urls),
      "eye-half": cursor(outlined(EYE_HALF), "centre", "default", set, urls),
      "eye-shut": cursor(outlined(EYE_SHUT), "centre", "default", set, urls),
      boots: cursor(boots(null), "centre", "default", set, urls),
      "boots-front": cursor(boots("front"), "centre", "default", set, urls),
      "boots-back": cursor(boots("back"), "centre", "default", set, urls),
      // The tip of the tree, its top pixel inside the black edge, is the point.
      fir: cursor(outlined(FIR), [2 * PIXEL + 1, PIXEL], "default", set, urls)
    };
    root.style.setProperty("--cursor-off", this.values.fir);
    for (const url of urls) {
      const img = new Image();
      img.src = url;
      this.loaded.push(img);
    }
    this.show();
    // A still eye for those who'd rather nothing moved that they didn't move themselves.
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) this.nextBlink();
  }

  /**
   * Every frame: whether the player is only looking (standing, or the walk out of their hands),
   * and, walking, how far through its steps the walker is (one per footfall), or null while it stands.
   */
  frame(look: boolean, stride: number | null): void {
    this.started = true;
    this.look = look;
    if (!look) {
      if (stride === null) this.feet = "boots";
      else {
        const step = Math.floor(stride);
        this.feet = stride - step < PLANTED ? "boots" : step % 2 === 0 ? "boots-front" : "boots-back";
      }
    }
    this.show();
  }

  dispose(): void {
    window.clearTimeout(this.blinkTimer);
    this.root.style.removeProperty("--cursor");
    this.root.style.removeProperty("--cursor-off");
  }

  private show(): void {
    const key = !this.started ? "fir" : this.look ? `eye-${this.eye}` : this.feet;
    if (key === this.shown) return;
    this.shown = key;
    this.root.style.setProperty("--cursor", this.values[key]);
  }

  private nextBlink(): void {
    const gap = BLINK_GAP_MIN + Math.random() * (BLINK_GAP_MAX - BLINK_GAP_MIN);
    this.blinkTimer = window.setTimeout(() => this.blink(Math.random() < DOUBLE_BLINK ? 2 : 1), gap);
  }

  /** Runs through a blink (or two), then waits for the next. */
  private blink(times: number, i = 0): void {
    if (i === BLINK.length) {
      this.eye = "open";
      this.show();
      if (times > 1) this.blinkTimer = window.setTimeout(() => this.blink(times - 1), 140);
      else this.nextBlink();
      return;
    }
    this.eye = BLINK[i].eye;
    this.show();
    this.blinkTimer = window.setTimeout(() => this.blink(times, i + 1), BLINK[i].ms);
  }
}
