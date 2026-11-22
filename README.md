# Blizzard in the Forest

A first-person walk through a procedural winter forest in a blizzard, rendered in PlayStation 1 style (~240p resolution, integer-scaled square pixels, vertex snapping, affine-mapped snow, and 15-bit dithered colour) with a generative Web Audio soundscape.

**Play:** [forest.ivanen.co](https://forest.ivanen.co)

## Stack

- **Three.js** + custom GLSL shaders (3D noise fog, blizzard particles, PS1 retro post-processing)
- **Web Audio API** (synthesized 22 kHz ambient score, directional wind, footsteps, and spatial cues — no external audio files)
- **TypeScript** + **Vite**
- **Cloudflare Workers** (static assets via Wrangler)

## Getting Started

### Requirements

- Node.js `>=22.12`
- pnpm 10 (`corepack enable` activates the version pinned in `package.json`)

### Local Development

```bash
pnpm install
pnpm dev
```

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the Vite dev server with HMR |
| `pnpm check` | Type-check the project (`tsc --noEmit`) |
| `pnpm build` | Create the static production build in `dist/` |
| `pnpm preview` | Serve the production build locally |
| `pnpm cf:dev` | Build and run locally under Wrangler |
| `pnpm release` | Type-check, build, and deploy to Cloudflare Workers |
| `pnpm rollback` | Roll back to the previous Cloudflare Workers deployment |

> **Note:** `pnpm deploy` is a built-in pnpm workspace command. Use `pnpm release` (or `pnpm run deploy` to skip the type-check).

## Project Structure

```text
index.html             Entry HTML (loader, title/end screens, HUD)
public/
  _headers             Long-term immutable caching for /assets/*
  favicon.svg
src/
  main.ts              UI lifecycle, sound toggle, hints, title/end screens
  styles/main.css      Pixel-grid typography (Jersey 10) and UI styles
  lib/pixel.ts         Font loading and integer pixel-grid snapping
  game/
    main.ts            Renderer setup, warm-up pass, frame loop, walk restarts
    sound.ts           Procedural 22 kHz Web Audio engine and ambient score
    cursor.ts          Pixel-art pointer sprites (tree, eye, boots)
    lib/               Seeded PRNG, simplex noise, math helpers
    render/            Fog, sky dome, blizzard snow, PS1 vertex snap, post pass
    world/             Terrain, 32 m chunk streaming, trees, logs, tracks, sight
    actors/            Player steering/movement and procedural creatures
    props/             World landmarks and structures
    story/             Event timeline, pacing/tuning constants, scenes
```

## Debugging

In development (`pnpm dev`), `window.__forest` and `window.__sound` expose the live game subsystems in the browser DevTools console:

- `__forest.step(dt)` — advance the simulation by `dt` seconds without waiting for animation frames
- `__forest.restart("plain" | "colour" | "yeti")` — restart on a specific walk
- `__forest.story.skip()` / `__forest.hunt.skip()` — skip the wait timer for the next story beat
- `__forest.story.yeti.preview(x, z, heading, pace, roar)` — position and inspect the creature directly
- All world objects (`walker`, `world`, `weather`, `camera`, `scene`, `steering`, `sight`, `output`, etc.) are accessible on `__forest`

## Deployment

Configured in `wrangler.jsonc` as a static-assets Worker (`blizzard-in-the-forest`) bound to `forest.ivanen.co`.

```bash
pnpm exec wrangler login
pnpm release
```

To roll back a release:

```bash
pnpm rollback
pnpm exec wrangler deployments list
```

GitHub Actions (`.github/workflows/check.yml`) runs `pnpm check` and `pnpm build` on pushes to `main` and pull requests; deployments are triggered manually.
