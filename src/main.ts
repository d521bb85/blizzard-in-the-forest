import "@fontsource/jersey-10/latin-400.css";
import "./styles/main.css";
import { start, type Game } from "./game/main";
import type { StoryEvent } from "./game/story/story";
import { Soundscape } from "./game/sound";
import { Cursor } from "./game/cursor";
import { snapEven, waitForPixelFont } from "./lib/pixel";

// While the tab is hidden the page holds still with the game: the fades stop where they are
// and the page's timers stop counting, and both carry on from there when it is back in view.
type Later = { fn: () => void; left: number; due: number; id: number };
const pending = new Set<Later>();
const arm = (t: Later) => {
  t.due = performance.now() + t.left;
  t.id = window.setTimeout(() => {
    pending.delete(t);
    t.fn();
  }, t.left);
};
/** setTimeout on the page's own clock, which stands still while the tab is hidden. */
const later = (fn: () => void, ms: number): Later => {
  const t = { fn, left: ms, due: 0, id: 0 };
  pending.add(t);
  if (!document.hidden) arm(t);
  return t;
};
const cancel = (t: Later | null) => {
  if (!t) return;
  window.clearTimeout(t.id);
  pending.delete(t);
};
let held: Animation[] = [];
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    held = document.getAnimations().filter((a) => a.playState === "running");
    for (const a of held) a.pause();
    for (const t of pending) {
      window.clearTimeout(t.id);
      t.left = Math.max(0, t.due - performance.now());
    }
  } else {
    for (const a of held) a.play();
    held = [];
    for (const t of pending) arm(t);
  }
});

// The tree while the forest loads and on the title screen, then whatever the walk calls for.
const cursor = new Cursor();

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const loader = document.getElementById("loader") as HTMLDivElement;
const bar = loader.querySelector(".bar") as HTMLDivElement;
const steerText = document.querySelector("#steer-hint .part") as HTMLElement;
const startText = document.querySelector("#hint span") as HTMLElement;

// The hints speak to the hand in use: the last pointer pressed, else the main one.
// Touch and pen steer only while pressed, so both get the finger wording.
let touch = window.matchMedia("(pointer: coarse)").matches;
const showStartHint = () => {
  startText.textContent = touch ? "Tap to start walking" : "Click or press Space to start walking";
};
showStartHint();
window.addEventListener(
  "pointerdown",
  (e) => {
    const was = touch;
    touch = e.pointerType !== "mouse";
    if (touch !== was) {
      showStartHint();
      snapHints();
    }
  },
  { capture: true }
);

// Centring puts a line on a half pixel when the leftover width is odd; one pixel of padding evens it out.
const snapHints = () => {
  for (const line of document.querySelectorAll<HTMLElement>(".hint .line")) {
    snapEven(line, line, line.parentElement as HTMLElement, 32);
  }
};
snapHints();
window.addEventListener("resize", snapHints);
document.fonts?.ready.then(snapHints);

const STEER_HINT_MS = 8000;
let steerHintTimer: Later | null = null;
const showSteerHint = () => {
  // Only the first half differs; the second ("to the left or right to turn") is shared.
  steerText.textContent = touch ? "Touch and hold above the middle to go forward," : "Move the pointer above the middle to go forward,";
  snapHints();
  document.body.classList.add("steer-hint");
  steerHintTimer = later(() => document.body.classList.remove("steer-hint"), STEER_HINT_MS);
};
const onWalkingChange = (walking: boolean) => {
  document.body.classList.toggle("walking", walking);
  cancel(steerHintTimer);
  document.body.classList.remove("steer-hint");
  // Every time walking starts, say for a few seconds how to steer (once the page is up: see Begin).
  if (walking && document.body.classList.contains("ready")) showSteerHint();
};

// Sound: off on every visit until the switch is pressed, so the switch always shows what is heard.
const sound = new Soundscape();
if (import.meta.env.DEV) Object.assign(window, { __sound: sound });
const soundButton = document.getElementById("sound") as HTMLButtonElement;
const soundLabel = soundButton.querySelector(".label") as HTMLElement;
const showSound = () => {
  soundButton.setAttribute("aria-pressed", String(sound.enabled));
  soundLabel.textContent = sound.enabled ? "Sound on (M)" : "Sound off (M)";
};
showSound();
const toggleSound = () => {
  if (sound.enabled) sound.disable();
  else sound.enable();
  showSound();
};
soundButton.addEventListener("click", toggleSound);
// M flips the switch. Matched by the key's place (KeyM), not its letter, so it works on any
// layout (it is Ь on a Russian one); shortcuts such as Cmd+M are left to the browser.
window.addEventListener("keydown", (e) => {
  if (e.code !== "KeyM" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!document.body.classList.contains("ready")) return;
  e.preventDefault();
  toggleSound();
});
// Space walks, wherever focus is; it never flips the switch.
soundButton.addEventListener("keyup", (e) => {
  if (e.code === "Space") e.preventDefault();
});

// The story: lines at the bottom, and the title / end screens.
const body = document.body;
const quiet = () =>
  body.classList.toggle("quiet", ["sign-text", "scene", "ended", "title"].some((c) => body.classList.contains(c)));
let game: Game | null = null;
const startOver = document.getElementById("start-over") as HTMLButtonElement;
const endingScreen = document.getElementById("ending") as HTMLElement;
// The endings: the first escape, in black and white; the second, in colour; being eaten,
// in either; and as the yeti, letting him get away, or not. That last is the end of it
// all: a letter, and a way back to the very first walk.
type Ending = "first" | "second" | "eaten" | "yeti-lost" | "yeti-won";
const notes = document.querySelectorAll<HTMLElement>("#ending [data-ending]");
let ending: Ending = "first";
let focusTimer: Later | null = null;

// The same evening out as for the hints, for the centred site link.
const credits = document.getElementById("credits") as HTMLElement;
const creditLink = credits.querySelector("a") as HTMLElement;
const snapCredits = () => snapEven(credits, creditLink);
window.addEventListener("resize", snapCredits);
document.fonts?.ready.then(snapCredits);

const showEnding = (which: Ending) => {
  ending = which;
  // The end screen is still hidden: put up the words for this one before it fades in.
  for (const note of notes) note.hidden = note.dataset.ending !== which;
  // After the last ending the way back is to the very first walk, and says so.
  const last = which === "yeti-won";
  endingScreen.classList.toggle("with-letter", last);
  startOver.textContent = last ? "Begin again" : "Start over";
  snapCredits();
  body.classList.add("ended");
  cancel(focusTimer);
  focusTimer = later(() => startOver.focus({ preventScroll: true }), 300);
};

const onStory = (e: StoryEvent) => {
  if (e.type === "sign") {
    body.classList.toggle("sign-text", e.visible);
    if (e.visible) snapHints();
  } else if (e.type === "inside" || e.type === "caught") {
    // The story has the screen: going into the hut, or in the yeti's hands.
    body.classList.remove("sign-text");
    body.classList.add("scene");
  } else if (e.type === "escaped") {
    // Through the yeti's eyes, he is the one who escaped.
    const walk = game?.walk ?? "plain";
    showEnding(walk === "yeti" ? "yeti-lost" : walk === "colour" ? "second" : "first");
  } else if (e.type === "eaten") {
    showEnding(game?.walk === "yeti" ? "yeti-won" : "eaten");
  }
  quiet();
};

const showTitle = () => {
  snapCredits();
  body.classList.add("title");
  quiet();
};

Promise.all([
  start(canvas, {
    progress: (p) => {
      bar.style.transform = `scaleX(${p})`;
    },
    onWalkingChange,
    onStory,
    sound,
    cursor,
    holdStart: true
  }),
  waitForPixelFont()
])
  .then(([g]) => {
    game = g;
    later(() => {
      loader.classList.add("done");
      later(showTitle, 450);
    }, 250);
  })
  .catch((err) => {
    // No WebGL2 (or it failed): still show the name and links on black.
    console.error(err);
    canvas.style.display = "none";
    // Nothing to walk in, so no walking hint either.
    body.classList.add("walking", "failed");
    snapCredits();
    loader.classList.add("done");
  });

startOver.addEventListener("click", () => {
  if (body.classList.contains("title")) {
    startOver.blur();
    body.classList.remove("title");
    quiet();
    game?.begin();
    body.classList.add("ready");
    return;
  }
  if (!body.classList.contains("ended")) return;
  cancel(focusTimer);
  startOver.blur();
  body.classList.remove("ended", "scene");
  quiet();
  // The first escape brings the world back in colour, the second has you walk as the yeti;
  // after anything else it is as it began.
  game?.restart(ending === "first" ? "colour" : ending === "second" ? "yeti" : "plain");
});
