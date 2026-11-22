import * as THREE from "three";
import { Blizzard, Weather } from "./render/blizzard";
import { Herd } from "./actors/deer";
import { findForestStart, findStart } from "./world/start";
import { Sky } from "./render/sky";
import { blizzardUniforms } from "./render/fog";
import { RetroPass } from "./render/post";
import { retroUniforms } from "./render/retro";
import { PERSON, Steering, Walker, YETI_BODY } from "./actors/player";
import { Hunt } from "./story/hunt";
import { Story, type StoryCues, type StoryEvent } from "./story/story";
import { Sight } from "./world/sight";
import { createHeightField } from "./world/terrain";
import { Tracks } from "./world/tracks";
import { buildVariants } from "./world/trees";
import { VIEW_RADIUS, World, createSnowMaterial, createTreeMaterial } from "./world/world";

const FOG_GRAY = 0.5;
/** In colour the air is whiter: not fog so much as fine snow hanging in it, catching the light. */
const COLOUR_FOG_GRAY = 0.66;
/**
 * In colour the air, the sky light and the sunlight each lean only a little: the sunlight warm, the sky light cool.
 * Proportions only: each is scaled to the brightness its gray has (the air to COLOUR_FOG_GRAY's).
 */
const FOG_TINT = [1.0, 1, 1.03] as const;
const SKY_TINT = [0.98, 1, 1.04] as const;
const SUN_TINT = [1.08, 0.99, 0.88] as const;
/** Output resolution cap; the output pass only scales pixels up, so it costs little. */
const OUT_DPR_CAP = 2;
/** The scene renders at about this many pixels along the shorter side of the screen. */
const SCENE_LINES = 240;
/** Flake brightness is matched to a render at this many pixels per CSS pixel, as the snow was tuned at. */
const FINE_DPR = 1.25;
/** Vertical field of view on landscape screens, in degrees. */
const BASE_FOV = 68;
/** Degrees above the horizon: high enough to sit near the top of the view when walking towards it. */
const SUN_ELEVATION = 24;
const MAX_PORTRAIT_FOV = 95;

/** Each new beginning is somewhere else in the endless forest, this far from the first. */
const RESTART_NEAR = 2500;
const RESTART_FAR = 6000;
/** The yeti's walk begins in the deepest of this many spots tried. */
const FOREST_TRIES = 24;
/** Faster than this (m/s), the boots on the pointer step; the walker's own footsteps start about here. */
const STEPPING = 0.05;

/**
 * Three walks: in black and white; once escaped, in colour; escaped again, as the yeti,
 * through its eyes, which see heat.
 */
export type Walk = "plain" | "colour" | "yeti";

/** Sets a colour to the tint's proportions at the given brightness (linear, Rec.709 weights). */
function setTinted(target: THREE.Color, tint: readonly [number, number, number], brightness: number): void {
  const k = brightness / (0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2]);
  target.r = tint[0] * k;
  target.g = tint[1] * k;
  target.b = tint[2] * k;
}

const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

export interface StartOptions {
  /** Loading progress, 0..1. */
  progress?: (p: number) => void;
  /** Walking was switched on or off. */
  onWalkingChange?: (walking: boolean) => void;
  /** Hears the weather and the walker every frame, and the story's sounds. */
  sound?: SoundListener;
  /** The story's turns: the sign's words in view, caught by the yeti, eaten, into the hut, safe. */
  onStory?: (e: StoryEvent) => void;
  /** Hears every frame what the pointer should show. */
  cursor?: CursorListener;
  /** Hold on black after loading until `begin()` is called (for a title screen). */
  holdStart?: boolean;
}

export interface CursorListener {
  /**
   * `look`: only looking about, standing or with the walk out of the player's hands (a scene,
   * the head turned to something, an end screen). `stride`: walking and moving, how far through
   * its footsteps the walker is (a whole number as each foot lands); null while it stands.
   */
  frame(look: boolean, stride: number | null): void;
}

export interface SoundListener extends StoryCues {
  frame(gust: number, windX: number, windZ: number, yaw: number, speed: number, steps: number, heavy: boolean): void;
}

export interface Game {
  dispose(): void;
  /** Begins the first walk when started with `holdStart`. */
  begin(): void;
  /** Begins again somewhere else in the forest, the story from the start: in black and white, in colour, or as the yeti. */
  restart(walk?: Walk): void;
  /** Which walk this is. */
  readonly walk: Walk;
}

export async function start(canvas: HTMLCanvasElement, options: StartOptions = {}): Promise<Game> {
  const progress = options.progress ?? (() => {});
  const seed = (Math.random() * 2 ** 31) | 0;
  // The scene renders into the output pass's own target, so the canvas needs no depth buffer.
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance"
  });
  const cleanup: (() => void)[] = [() => renderer.dispose()];
  const dispose = () => {
    renderer.setAnimationLoop(null);
    for (const fn of cleanup.reverse()) fn();
  };

  try {
    renderer.setClearColor(0x000000, 1);

    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const quality = coarse ? 0.45 : 1;

    const scene = new THREE.Scene();
    const fogLight = Math.pow(FOG_GRAY, 2.2);
    const fogColor = new THREE.Color().setScalar(fogLight);
    scene.background = fogColor;
    scene.fog = new THREE.FogExp2(fogColor, 0.05);
    // FogExp2 keeps a copy; share the one colour so the fog on everything changes with the sky and flakes.
    scene.fog.color = fogColor;

    const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.05, 160);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x80868c, 1.25);
    const sun = new THREE.DirectionalLight(0xffffff, 0.55);
    sun.position.set(0.3, 1, 0.2);
    scene.add(hemi, sun);

    /** Black and white, or colour: the switch every shader reads, the air and the lights. Call it with the screen black. */
    const setColour = (on: boolean) => {
      blizzardUniforms.uColour.value = on ? 1 : 0;
      if (on) {
        setTinted(fogColor, FOG_TINT, Math.pow(COLOUR_FOG_GRAY, 2.2));
        setTinted(hemi.color, SKY_TINT, 1);
        setTinted(sun.color, SUN_TINT, 1);
      } else {
        fogColor.setScalar(fogLight);
        hemi.color.setScalar(1);
        sun.color.setScalar(1);
      }
    };
    setColour(false);
    // The sun itself, low behind the clouds on the same side as the light.
    const sunAzimuth = Math.atan2(sun.position.z, sun.position.x);
    const sunElevation = THREE.MathUtils.degToRad(SUN_ELEVATION);
    blizzardUniforms.uSunDir.value
      .set(Math.cos(sunAzimuth) * Math.cos(sunElevation), Math.sin(sunElevation), Math.sin(sunAzimuth) * Math.cos(sunElevation))
      .normalize();
    const sky = new Sky(fogColor, 150);
    scene.add(sky.mesh);
    cleanup.push(() => sky.dispose());

    progress(0.1);
    await frame();

    const height = createHeightField(seed);
    const variants = buildVariants(seed);
    progress(0.45);
    await frame();

    // Phones: a shorter streaming radius (about 60% of the trees) behind slightly thicker fog.
    const viewRadius = coarse ? 72 : VIEW_RADIUS;
    const treeMaterial = createTreeMaterial();
    const world = new World(seed, height, variants, createSnowMaterial(), treeMaterial, viewRadius);
    scene.add(world.group);
    world.fill(0, 0);
    // Open, level snow ahead with trees in the distance, not a trunk or a drift up close.
    const start = findStart(world, height);
    world.fill(start.x, start.z);
    progress(0.7);
    await frame();

    const weather = new Weather(seed, coarse ? 1.18 : 1);
    weather.update(0);
    const blizzard = new Blizzard(seed, fogColor, quality);
    scene.add(blizzard.group);

    // What the walker can see: nothing in the forest comes or goes where this says it would show.
    const sight = new Sight(camera, height);
    const herd = new Herd(height, world, sight);
    scene.add(herd.group);
    cleanup.push(() => herd.dispose());

    // The walker's footprints: a person's only, filled in by the blizzard soon after.
    const tracks = new Tracks();
    scene.add(tracks.mesh);
    cleanup.push(() => tracks.dispose());

    const walker = new Walker(camera, height);
    walker.place(start.x, start.z, start.yaw);
    const steering = new Steering(canvas);
    steering.onWalkingChange = options.onWalkingChange ?? null;
    if (options.holdStart) steering.locked = true;

    const story = new Story({ world, height, walker, steering, camera, sight, cues: options.sound }, treeMaterial, (e) => options.onStory?.(e));
    scene.add(story.group);
    cleanup.push(() => story.dispose());
    const hunt = new Hunt(
      { world, height, walker, steering, camera, sight, cues: options.sound ?? {}, rand: Math.random },
      treeMaterial,
      (e) => options.onStory?.(e)
    );
    scene.add(hunt.group);
    cleanup.push(() => hunt.dispose());
    /** Which walk this is, and so whose story plays. */
    let walk: Walk = "plain";
    const tale = () => (walk === "yeti" ? hunt : story);

    // Half-float keeps the fog gradients free of banding; some mobile GPUs can't render to it.
    const ext = renderer.extensions;
    const output = new RetroPass(ext.has("EXT_color_buffer_half_float") || ext.has("EXT_color_buffer_float"));
    cleanup.push(() => output.dispose());
    const outSize = new THREE.Vector2();
    /** The field of view for this screen; the walker's eyes close in from it (Walker.zoom). */
    let fov = BASE_FOV;
    let zoom = 1;
    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      // Re-read the ratio: browser zoom or moving to another monitor changes it.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, OUT_DPR_CAP));
      renderer.setSize(w, h, false);
      renderer.getDrawingBufferSize(outSize);
      // Whole screen pixels per scene pixel, so every pixel is the same size.
      const pixel = Math.max(1, Math.round(Math.min(outSize.x, outSize.y) / SCENE_LINES));
      const sceneW = Math.ceil(outSize.x / pixel);
      const sceneH = Math.ceil(outSize.y / pixel);
      output.setSize(sceneW, sceneH, pixel, outSize.x, outSize.y);
      retroUniforms.uSnap.value.set(sceneW / 2, sceneH / 2);
      camera.aspect = sceneW / sceneH;
      // Portrait phones: keep the horizontal view as wide as on a square screen
      // instead of narrowing to a slit (capped so the edges don't stretch).
      fov =
        camera.aspect >= 1
          ? BASE_FOV
          : Math.min(MAX_PORTRAIT_FOV, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2)) / camera.aspect)));
      camera.fov = fov * zoom;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener("resize", resize);
    cleanup.push(() => window.removeEventListener("resize", resize));

    walker.update(0, steering, world, weather.gust);
    camera.updateMatrixWorld();
    blizzardUniforms.uCamWorld.value.copy(camera.matrixWorld);
    sky.update(camera);
    // The sign's board is painted before the frame drawn below, which is what sends it to the graphics card.
    await story.ready;
    // Compile the exact program variants the frame uses: scene into the small target, output pass to screen.
    renderer.setRenderTarget(output.target);
    const sceneCompile = renderer.compileAsync(scene, camera);
    renderer.setRenderTarget(null);
    await Promise.all([sceneCompile, output.compile(renderer)]);
    // Then one frame drawn in the dark with everything that will ever come into view in it (the
    // signpost, the hut, the yeti, the deer, every kind of tree), wherever it stands: compiling
    // builds the shaders, but only drawing sends shapes and textures to the graphics card, and
    // anything left for later would hitch the frame it first shows up in.
    world.cull(camera);
    world.stage(true);
    story.showForWarmUp();
    hunt.showForWarmUp();
    herd.showForWarmUp();
    const staged: THREE.Mesh[] = [];
    for (const group of [story.group, hunt.group, herd.group]) {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh && o.frustumCulled) staged.push(o);
      });
    }
    for (const mesh of staged) mesh.frustumCulled = false;
    output.render(renderer, scene, camera);
    for (const mesh of staged) mesh.frustumCulled = true;
    world.stage(false);
    herd.reset();
    story.reset();
    hunt.reset();
    if (options.holdStart) steering.locked = true;
    progress(1);
    await frame();

    const timer = new THREE.Timer();
    timer.connect(document);
    cleanup.push(() => timer.dispose());
    let fade = 0;
    let black = 0;

    /**
     * Somewhere new: a spot well away from here, a start picked there as on the first visit
     * (for the yeti, deep in the forest).
     */
    const restart = (hold: number, next: Walk) => {
      const p = walker.position;
      const yeti = next === "yeti";
      let cx = 0;
      let cz = 0;
      let deepest = -Infinity;
      for (let i = 0; i < (yeti ? FOREST_TRIES : 8); i++) {
        const a = Math.random() * Math.PI * 2;
        const d = RESTART_NEAR + Math.random() * (RESTART_FAR - RESTART_NEAR);
        const x = Math.sin(a) * d;
        const z = Math.cos(a) * d;
        if (Math.hypot(x - p.x, z - p.z) <= RESTART_NEAR) continue;
        const depth = yeti ? world.forest(x, z) : 0;
        if (depth > deepest) {
          deepest = depth;
          cx = x;
          cz = z;
          if (!yeti) break;
        }
      }
      // Every walk begins as the first one did: standing still, in clear, calm air, a deer crossing ahead.
      story.reset();
      hunt.reset();
      steering.setWalking(false);
      weather.reset();
      weather.update(0);
      herd.reset();
      world.fill(cx, cz);
      walker.body = yeti ? YETI_BODY : PERSON;
      const s = yeti ? findForestStart(world, height, cx, cz) : findStart(world, height, cx, cz);
      world.fill(s.x, s.z);
      walker.place(s.x, s.z, s.yaw);
      tracks.reset();
      walk = next;
      if (yeti) hunt.begin();
      walker.update(0, steering, world, weather.gust);
      // Nothing is drawn until the next frame, and that one is black.
      setColour(next === "colour");
      output.material.uniforms.uThermal.value = yeti ? 1 : 0;
      fade = 0;
      black = hold;
    };

    /** Everything a frame does but draw it. */
    const step = (dt: number) => {
      weather.update(dt);
      const t = tale();
      if (t.driving) t.drive(dt);
      else walker.update(dt, steering, world, weather.gust);
      tracks.update(dt, walker, world, weather.gust, walk !== "yeti" && !t.driving);
      // Turned to look at something, the eyes close in on it (and the story's scenes keep whatever it was).
      if (walker.zoom !== zoom && !t.driving) {
        zoom = walker.zoom;
        camera.fov = fov * zoom;
        camera.updateProjectionMatrix();
      }
      world.update(walker.position.x, walker.position.z);
      camera.updateMatrixWorld();
      sight.update(dt);
      t.update(dt);
      // With the yeti about, the deer run off into the fog, and no more come.
      if (t.chasing) herd.scatter();
      herd.update(dt, walker.position, walker.velocity, walker.yaw);
      blizzardUniforms.uCamWorld.value.copy(camera.matrixWorld);
      sky.update(camera);
      const fineHeight = window.innerHeight * Math.min(window.devicePixelRatio || 1, FINE_DPR);
      blizzard.update(dt, weather, camera, walker.velocity, walker.groundY, walker.slope, output.target.height, fineHeight);
      options.sound?.frame(weather.gust, weather.wind.x, weather.wind.z, walker.yaw, walker.speed, walker.steps, walk === "yeti");
      options.cursor?.frame(
        !steering.walking || steering.locked || t.driving || walker.focused,
        walker.speed > STEPPING ? walker.stride : null
      );

      if (black > 0) black -= dt;
      else fade = Math.min(1, fade + dt / 3.5);
      output.material.uniforms.uFade.value = fade * fade * (3 - 2 * fade) * (1 - t.blackout);
      world.cull(camera);
    };

    const tick = () => {
      timer.update();
      step(Math.min(timer.getDelta(), 0.1));
      output.render(renderer, scene, camera);
    };

    // In development: the pieces, and `step(dt)` to run the walk on a frame at a time without waiting for the screen.
    if (import.meta.env.DEV) {
      Object.assign(window, {
        __forest: { walker, world, variants, steering, renderer, herd, story, hunt, tracks, sight, weather, output, camera, scene, step, restart: (w: Walk) => restart(0, w) }
      });
    }
    let begun = !options.holdStart;
    const begin = () => {
      if (begun) return;
      begun = true;
      steering.locked = false;
      fade = 0;
      black = 0.3;
      timer.reset();
      if (!document.hidden) renderer.setAnimationLoop(tick);
    };
    // While the tab is hidden nothing runs: no frame is stepped or drawn. Back in view, the walk
    // carries on from where it stood, the time away not counted.
    const onVisibility = () => {
      if (document.hidden) {
        renderer.setAnimationLoop(null);
      } else if (begun) {
        timer.reset();
        renderer.setAnimationLoop(tick);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    cleanup.push(() => document.removeEventListener("visibilitychange", onVisibility));
    if (begun && !document.hidden) renderer.setAnimationLoop(tick);
    return {
      dispose,
      begin,
      restart: (next: Walk = "plain") => restart(0.3, next),
      get walk() {
        return walk;
      }
    };
  } catch (err) {
    dispose();
    throw err;
  }
}
