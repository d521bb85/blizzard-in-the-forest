# Blizzard in the Forest

An endless first-person walk through a snowy forest in a blizzard, with a short story in it. Black and white (the second time round, in colour; the third, through the yeti's eyes), rendered like a PlayStation 1 game: about 240 lines, big square pixels, wobbling vertices and dithered 15-bit colour, with pixel-font type (Jersey 10) for the title, hints, and end screens.

Built with TypeScript, Vite, and Three.js, deployed as a static Cloudflare Worker (`forest.ivanen.co`).

## Controls

- A click (a tap, or Space) starts walking; another click stops. M switches sound on and off (by key position, so on any keyboard layout).
- While walking, the pointer's offset from the screen centre is the direction to walk: up goes ahead, sideways turns, down turns around. The further from the centre, the faster.
- While standing, the same offset only turns the head: left and right, up and down.
- Inside the area around the centre nothing moves, whether walking or standing.
- The pointer is drawn in the game's big pixels, white with a black edge. Over the scene and the end screens it is an eye while standing and looking about, or while the walk is out of your hands (a scene playing out, the head turned to something, an end screen), blinking now and then; and a pair of felt boots in galoshes, seen from the side, while walking, standing together when the walker stands and stepping in time with its footfalls when it moves. Everywhere else (the links and buttons, while the forest loads, and on the title screen) it is a snowy fir tree leaning like an arrow, its tip the point.
- On touch screens a finger works like the pointer: hold or drag to steer, tap to start or stop. Only the first finger counts; long presses and drags don't toggle.
- While standing, a blinking "Click or press Space to start walking" ("Tap to start walking" on touch screens) shows at the bottom. Each time walking starts, a steady "Move the pointer above the middle to go forward, to the left or right to turn" ("Touch and hold above the middle to go forward, to the left or right to turn" on touch and pen) shows for a few seconds.
- Low snow drifts (up to about 0.8 m) and fallen trunks are walked over; taller drifts, trees and the torn-up root plates of fallen trees are walked around. Spruces only block with their denser inner branches, so gaps between them that look passable are.
- The speaker in the top right corner switches sound on and off; on desktop it is labelled "Sound off (M)" or "Sound on (M)", on touch screens it is the speaker alone. It is off on every visit until switched on, so the switch always shows whether sound is playing.
- Walking leaves footprints in the snow behind you, left and right, longer at a run; the blizzard fills them in within about ten seconds, faster in gusts, the shallow edges first. Neither the deer, the yeti nor the man leave any.
- Phones stream a shorter radius behind slightly thicker fog, and portrait screens get a wider field of view.

## The story

- After a minute's walking, a change of direction (a turn of 40° or more, once the new heading has settled) stands a wooden signpost ahead on the new way: just beyond what the fog lets through at that moment (40-60 m), a couple of metres to one side, its board turned to whoever comes up. It comes out of the fog as you walk on. Walking straight on for half a minute brings it too.
- Reading it: within 10 m, from in front, with the whole board on screen for half a second; walking up to it reads it, and so does running past within a few metres. The carved words, "Tread softly in these woods, and softer still when the snow begins to howl.", then show at the bottom of the screen whenever the board is looked at.
- Left unread and left behind (out of view, 32 m or more off and lost in the fog), it is taken away, and the next change of direction brings it again. Unread, nothing else happens: the forest can be wandered for ever. Once read, it stays where it stands.
- 40 to 75 s after it is read, with the first strong gust, a yeti comes: set walking dead ahead, beyond what the fog lets through (38-60 m), so it is first a pale shape in the fog straight in front, then a figure coming on. Until it has been seen it is kept in front, whichever way you turn. About 16 m off (further when you are running at it, so there is always the same time to turn), in view, it rears up and roars. Whichever way you were looking (or running), the head turns to it, the view closing in on it, and you stand rooted for 1.2 s; the roar lasts that much longer, so there are still 2 s to turn and run. Then it runs at 5.3 m/s (a flat-out run is 6.2). However far ahead you get, it closes in out of sight to stay within about 34 m.
- With the yeti about, the deer run off into the fog, and no more come.
- Turning to run from it brings a snowed-in log hut out of the fog about 115 m ahead, on the levellest ground there, cleared of trees, facing you: a small square cabin with its gable to the front, notched corners, a window with a pale carved frame and open shutters, a chimney, and the door a little ajar. Run past without finding it, and it stands ahead again.
- Caught: in one movement it swings you round to face it, lifts you over its head and brings you straight down to its open jaws; the dark closes over, and an end screen says "You were eaten by the yeti." under the title BLIZZARD IN THE FOREST, with a "Start over" button.
- Reaching the door (within about 3.5 m, facing it): it swings half open while you carry on in one unbroken glide, slowing from your own pace, through the gap into a dim room of log walls and floorboards, where a table with a candle stub stands straight ahead, a chest in the corner beside it and a bed along the wall under the window; the dark fills the view as you go in; then the end screen says "You escaped the yeti. What happened next, no one knows.", with "Start over". Starting over after an escape begins the next walk in colour; escaping again has an ending of its own, and starting over after that begins the third walk, as the yeti. Starting over after being eaten begins again from the first walk. The sound switch stays in its corner on the end screens, so sound can be switched there too.
- The third walk is seen through the yeti's eyes: higher up (2.3 m), slow to turn, each heavy footfall rocking the view and thudding in the snow. It sees daylight badly (a dim, flat, wavering blur, all but gray) but sees heat: the deer glow through their coats, the man's sheepskin coat and felt boots show cool, his bare face burns, and heat shows through the fog far better than light does. It begins deep in the forest, a spruce bough at the edge of the view, ambling at no more than 2.3 m/s.
- 30 to 42 s in, a man (a sheepskin coat to the knees, a scarf, a fur hat with the flaps down, felt boots) comes walking towards the yeti through the trees, out of the fog ahead, making to pass a few metres to one side of it wherever it has got to: first a glow (from about 45 m), then a figure (from about 30). Heat shows through the fog much further than light, but far enough off it is gone too, so he starts where not even his heat shows. Lose track of him unspotted and he comes again ahead a little later.
- Spotted (in sight within 22 m, or bumped into from behind), the yeti roars with its arms flung up for 1.3 s, its head turning to him and the view closing in, holding him in the middle; he stops dead, turns to look, and runs without a sound at 4.6 m/s for a hut about 40 m on, away from the yeti, glancing back now and then. The yeti charges at up to 7.6 m/s, its pace rising evenly with the pointer's offset. A clean, flat-out chase catches him with a second or two to spare; bumping trees and wide turns lose him.
- Caught: through its eyes, it hauls him up overhead by the middle, kicking, and brings him down, his face to its mouth, as the dark comes. The end screen's line is a yeti's mumble, then a short note (thank you, share it if you enjoyed it), then "Start over", which begins again from the very first walk.
- If he gets through the door, it shuts in the yeti's face, the dark comes over its eyes, and the end screen mumbles too, with "Start over", which begins again from the first walk.
- Nothing comes or goes where it could be seen to: everything is put where the fog hides it or out of view, and taken away the same way.

## How it works

`index.html`, `src/main.ts`, and `src/styles/main.css` present the loader, title screen, HUD, and endings; the game itself lives in `src/game`.

- `main.ts`: sets up the renderer and the scene, loads everything (ending with one frame drawn in the dark with everything that will ever appear in it, so nothing is left to compile or upload when it first comes into view), holds on the title screen until `begin()` is called, and runs the frame loop.
- `sound.ts`: all sound, generated in the browser and made to sound like a PlayStation 1: instruments are short 22 kHz samples built once and played at other pitches, through a long dark reverb and an echo.
- `cursor.ts`: the pointer's pictures, drawn from pixel masks at load (with a 2x copy for sharp screens, or as SVG where a canvas can't be read back) and all loaded up front.
- `lib/`: seeded random numbers, simplex noise, angles, easing, grays.
- `render/`: wind-advected 3D noise fog, sky dome, blizzard snow, PS1 vertex snap / affine mapping, and 240p retro dithered post-processing pass.
- `world/`: procedural terrain, chunk streaming, instanced trees, fallen logs, colliders, spawn picker, footprints, and visibility checks.
- `actors/`: player steering/walking, deer herds, the yeti, and the man.
- `props/`: signpost and log hut.
- `story/`: timeline, tuning, beats, closing scenes, and the third walk's hunt.

In development, `__forest` in the console holds the pieces (`__forest.story.skip()`, `__forest.restart("yeti")`, `__forest.step(dt)`, etc.).

## Requirements

- Node.js 22.12+
- pnpm 10 (`corepack enable` installs the version pinned in `package.json`)
- A Cloudflare account for deployment

## Scripts

```bash
pnpm install
pnpm dev
```

- `pnpm dev` runs the Vite development server.
- `pnpm check` type-checks the project with `tsc --noEmit`.
- `pnpm build` creates the static production build in `dist/`.
- `pnpm preview` previews the production build locally.
- `pnpm cf:dev` builds and runs the Cloudflare Worker locally with Wrangler.
- `pnpm release` type-checks, builds, and deploys to production.
- `pnpm rollback` puts the previous production version back.

Note: `pnpm deploy` is a built-in pnpm command, not this project's script. Use `pnpm release` (or `pnpm run deploy`, which skips the type-check).

## Releasing

The game is deployed as a static Cloudflare Worker named `blizzard-in-the-forest`, configured in `wrangler.jsonc`, intended for `forest.ivanen.co`.

Releases are made by hand. `.github/workflows/check.yml` only type-checks and builds each push to `main` and each pull request; it deploys nothing.

Sign in once:

```bash
pnpm exec wrangler login
```

Then release:

```bash
pnpm release
```

To bind the custom domain `forest.ivanen.co`, add it in the Cloudflare dashboard under the `blizzard-in-the-forest` Worker's **Domains & Routes** (or add a `routes` entry with `custom_domain: true` in `wrangler.jsonc`).
