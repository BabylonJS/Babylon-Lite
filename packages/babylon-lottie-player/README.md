# @babylonjs/lottie-player

A function-based **WebGL2 vector Lottie player**. It renders morphing vector paths with a
stencil-then-cover pipeline on top of
[`@babylonjs/lite-gl`](https://www.npmjs.com/package/@babylonjs/lite-gl), a small WebGL2
micro-engine. Full and shapes-only entry points let applications choose the supported feature set
they need.

Version 10 is an intentional replacement of the experimental Babylon.js player with this
Lite-backed renderer. The package has independent SemVer from `@babylonjs/core`, `@babylonjs/lite`,
and `@babylonjs/lite-gl`.

## Migrating from experimental v9

- Install `@babylonjs/lottie-player@^10` explicitly. Existing `^9` ranges remain on the old
  experimental line and do not silently adopt this breaking API.
- Replace v9 player calls with the worker-first API documented below. There is no compatibility
  wrapper; v10 intentionally replaces the experimental API.
- The canonical package name remains `@babylonjs/lottie-player`. Its source is now owned by
  [BabylonJS/Babylon-Lite](https://github.com/BabylonJS/Babylon-Lite/tree/master/packages/babylon-lottie-player)
  and its runtime dependency is `@babylonjs/lite-gl`.
- The experimental v9 package used the MIT license. Version 10 and its Lite-backed implementation
  are licensed under Apache-2.0; update redistributed license notices accordingly.

> **Dependency.** This package depends on the published [`@babylonjs/lite-gl`](https://www.npmjs.com/package/@babylonjs/lite-gl)
> `^1.7.0` line (its currently validated WebGL2 backend) as a normal npm dependency. Repository
> development resolves that dependency to the local workspace package. The raster **sprite** reference used by the
> benchmark is included under `measure/vendor/` with its own license; it is not part of the published
> package.

---

## Quick start

All commands run from the repo root:

| Goal                      | Command                      | What it does                                                                                                                               |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Live viewer**           | `pnpm demo:lottie-player`    | Builds + serves an interactive viewer at <http://localhost:5180>. Pick an animation, renderer (Full / Shapes), and thread (Main / Worker). |
| **Measurement dashboard** | `pnpm measure:lottie-player` | Runs the full Sprite-vs-Stencil **size + perf** comparison in headed Chrome and opens a self-contained `dashboard.html`.                   |
| **Build the library**     | `pnpm build:lottie-player`   | Compiles per-module ESM/types and self-contained classic workers into `dist/`.                                                             |
| **Watch build**           | `pnpm dev:lottie-player`     | Runs TypeScript in watch mode.                                                                                                             |

The two `node` scripts behind those:

- `node demo/serve.mjs` — the live viewer (esbuild watch + dev server).
- `node measure/bench/run.mjs` — the one-command dashboard.

### Measurement options (env vars)

```powershell
$env:ANIMS="anim1,anim2"    # measure a subset (default: every *.json in anims/)
$env:PERF_DURATION="5"      # seconds per perf run (default 5)
$env:NO_OPEN="1"            # don't auto-open the dashboard
pnpm measure
```

---

## What this is, and why

Lottie is a JSON format for vector animations: shapes, gradients, strokes, masks, morphing paths,
text, and image layers. This repository contains the stencil player and a reproducible benchmark
against a raster sprite implementation:

- **Sprite player** (raster) — pre-rasterizes each shape into a texture atlas and animates
  transforms. Tiny per-frame cost (**one draw call per frame**), but it **cannot** represent morphing
  paths, image layers, masks, or track mattes (it bakes one frame).
- **Stencil player** (vector, this package) — re-tessellates and fills paths every frame via
  stencil-then-cover, so it renders morphs, masks, and vector alpha track mattes.

The sprite benchmark source is included in the repository so the comparison is reproducible. It is
measurement-only and does not ship in `@babylonjs/lottie-player`.

### Goals

- **WebGL2.** The renderer targets the broadly available `@babylonjs/lite-gl` WebGL2 surface.
- **Explicit feature entry points.** The shapes-only entry never references text or image renderers;
  the full player initializes only the renderers required by the loaded document.
- **Small bundle, fast time-to-first-frame.** Measured continuously (see below).
- **Off-thread in production.** The shipped path renders on an `OffscreenCanvas` inside a Web
  Worker. The main-thread player exists for **testing and measurement** only.

---

## Public API

Every public player runs off-thread. Parsing, tessellation, animation, and GPU submission happen on
an `OffscreenCanvas` in a Web Worker; the main thread only owns the DOM canvas, sizing, and control
messages. The local renderer factories remain internal because the workers and repository
measurement harness use them, but they are not package exports.

There are two feature variants:

- **Full** renders every supported layer: shapes, solids, text, and images.
- **Shapes-only** renders shape and solid layers, including gradients, strokes, masks, vector alpha
  mattes, and morphs. It never reaches the text or image renderers, so vector-only animations ship a
  smaller worker.

Bundler entries bind the worker variant automatically. Explicit-URL hosts use one shared standalone
client; the supplied worker file selects the renderer:

| Delivery                   | Full                                                                     | Shapes-only                                                                |
| -------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Bundler (automatic worker) | `@babylonjs/lottie-player` → `createLottieWorkerPlayer`                  | `@babylonjs/lottie-player/shapes` → `createShapeWorkerPlayer`              |
| Explicit worker URL (ESM)  | `@babylonjs/lottie-player/standalone` + `workers/full.worker.js`         | `@babylonjs/lottie-player/standalone` + `workers/shapes.worker.js`         |
| Classic script             | `standalone.min.js` (`globalThis.LiteLottie`) + `workers/full.worker.js` | `standalone.min.js` (`globalThis.LiteLottie`) + `workers/shapes.worker.js` |

### Bundler usage

The root and `/shapes` entries create their matching worker automatically:

```ts
import { createLottieWorkerPlayer, playWorkerAnimationAsync } from "@babylonjs/lottie-player";

const player = createLottieWorkerPlayer();
await playWorkerAnimationAsync(player, {
    container: document.getElementById("animation")!,
    animationSource: "./animation.json",
    loop: true,
    onError: () => document.getElementById("fallback")?.removeAttribute("hidden"),
});
```

Each player handle is one-shot. The first accepted `playWorkerAnimationAsync` call resolves `true`
after setup is queued; another call on the same handle resolves `false`, including while a URL is
still loading. Use `onFirstRender` when the first painted frame matters. A worker load, parse, or
render failure invokes `onError` and disposes the player. The callback deliberately carries no error
string so production delivery does not pay for diagnostic text; applications should show their
normal static fallback and may log the animation URL themselves.

When `animationSource` is a URL, external image assets (`u` + `p`) resolve relative to the final
JSON response URL, including after redirects. A parsed document has no source URL, so its external
image paths must already be absolute; embedded `data:` images work in either form.

For a vector-only animation, switch both the entry and factory:

```ts
import { createShapeWorkerPlayer, playWorkerAnimationAsync } from "@babylonjs/lottie-player/shapes";

const player = createShapeWorkerPlayer();
await playWorkerAnimationAsync(player, {
    container: document.getElementById("animation")!,
    animationSource: "./animation.json",
});
```

### Explicit worker URL

Use `/standalone` when the host serves a prebuilt worker itself. Pass the same-origin URL of either
the full or shapes worker:

```ts
import { createLottieWorkerPlayer, playWorkerAnimationAsync } from "@babylonjs/lottie-player/standalone";

const player = createLottieWorkerPlayer({ workerUrl: "/static/workers/full.worker.js" });
await playWorkerAnimationAsync(player, {
    container: document.getElementById("animation")!,
    animationSource: "./animation.json",
});
```

Classic-script hosts use the equivalent global. `createLottieWorkerPlayer` is variant-agnostic in
this entry; choose `workers/full.worker.js` or `workers/shapes.worker.js` through `workerUrl`.

```html
<script src="./standalone.min.js"></script>
<script>
    const player = LiteLottie.createLottieWorkerPlayer({ workerUrl: "./workers/full.worker.js" });
    LiteLottie.playWorkerAnimationAsync(player, {
        container: document.getElementById("animation"),
        animationSource: "./animation.json",
    });
</script>
```

### Fixed shapes splash

For first-paint-critical, fixed-layout vector splashes, the package also ships a paired classic
script and shapes worker:

- `fixed-shapes-splash/client.min.js`
- `fixed-shapes-splash/worker.min.js`

This client auto-starts under a deliberately narrow HTML contract:

```html
<canvas id="l" data-a="animation.json" style="width: 512px; height: 512px"></canvas>
<script src="./fixed-shapes-splash/client.min.js"></script>
```

Copy the animation JSON beside the two scripts. The client derives their directory from
`document.currentScript`, loads `worker.min.js`, and stores the worker on `canvas._w` for the host's
later dismissal path to terminate.

This path is an auto-executing classic script, not an ESM API. It assumes the host has already gated
on `OffscreenCanvas`, provides stable nonzero canvas dimensions, keeps an independent fallback, and
owns worker termination. It intentionally omits capability checks, resize observation, callbacks,
inline animation objects, variables, configurable looping, and error UI. Use the regular bundler or
standalone entries when those capabilities are needed.

---

## Architecture

### Rendering pipeline

Per frame, the player walks layers back-to-front, resolves each layer's world matrix (parent chain
applied), and dispatches to a **renderer** keyed by layer kind:

- **Fill** (`rendering/fill-renderer.ts`) — the core. Vector fills via **stencil-then-cover**: a stencil pass
  marks pixel coverage (nonzero winding emulated with two cull passes — back faces `INCR_WRAP`,
  front faces `DECR_WRAP`, since lite-gl's stencil is single-sided), then a full-screen cover pass
  paints the covered region. Also handles solids, linear/radial gradients, strokes (tessellated to
  geometry in `rendering/stroke-geometry.ts`), add-mode masks, and opaque vector alpha track mattes. Masks and
  mattes reserve one stencil bit each, so their intersection needs no texture or extra framebuffer.
  MSAA comes free from the antialiased default framebuffer.
- **Text** (`rendering/text-renderer.ts`) — rasterizes each text block once on an **`OffscreenCanvas`** (so it
  works on the main thread _and_ in a worker) and draws it as a premultiplied textured quad.
- **Image** (`rendering/image-renderer.ts`) — decodes each asset via `loadTexture2D` (`fetch` +
  `createImageBitmap`, worker-safe) and draws a textured quad.

### Module map (`src/`)

| Area                | Files                                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Public entries**  | `index.ts` (`.`), `shapes.ts` (`./shapes`), `standalone.ts` (`./standalone`), `fixed-shapes-splash.ts` (auto-starting static client)                                              |
| **Animation model** | `animation/lottie-raw.ts`, `animation/parse.ts`, `animation/sample.ts`, `animation/matrix.ts`, `animation/geometry.ts`                                                            |
| **Players**         | `player/player-core.ts` (renderer-agnostic spine), `player/full-player.ts`, `player/shapes-player.ts`                                                                             |
| **Rendering**       | `rendering/fill-renderer.ts`, `rendering/stroke-geometry.ts`, `rendering/text-renderer.ts`, `rendering/image-renderer.ts`, `rendering/layer-renderer.ts`, `rendering/gl-frame.ts` |
| **Client delivery** | `client/runtime.ts`, `client/blob-worker.ts`, `client/default-worker.ts`, `client/full-client.ts`, `client/shapes-client.ts`                                                      |
| **Worker delivery** | `worker/protocol.ts`, `worker/controller.ts`, `worker/dispatch.ts`, `worker/full.worker.ts`, `worker/shapes.worker.ts`                                                            |

### Worker (`src/worker/`)

The production off-thread path. Architecture mirrors the sprite player's worker:

| File                                  | Role                                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol.ts`                         | The message types exchanged between main thread and worker.                                                                                                                                   |
| `controller.ts`                       | Renderer-agnostic playback controller: owns the engine, the clock, and the render loop (reusing lite-gl's `runRenderLoop`). Parameterized by a player factory, so it drives full _or_ shapes. |
| `dispatch.ts`                         | `runLottieWorker(factory)` — installs the worker's `onmessage` handler. Factory-parameterized, so the same code serves both variants.                                                         |
| `full.worker.ts` / `shapes.worker.ts` | The two worker entry modules (`runLottieWorker` with `createLottiePlayer` or `createShapePlayer`). A bundler emits each as its own worker chunk.                                              |

> **Worker-safety:** fill, stroke, mask, and image renderers are DOM-free. **Text** was the only
> worker-unsafe renderer (it used `document.createElement`); it now rasterizes on an
> `OffscreenCanvas` and uploads via `createDynamicTexture` / `updateDynamicTexture`, so one code path
> serves both threads.

---

## Measurement

The whole point of the `measure/` tooling is an **honest, apples-to-apples Sprite-vs-Stencil
comparison**. `pnpm measure` produces a single shareable `dashboard.html` with one card per
animation.

### Methodology

- **Players compared:** the **local** (main-thread) player of each, so the comparison is
  renderer-to-renderer with no worker infrastructure skewing either side. (The worker just relocates
  the same render work, so measuring it in-thread is both fair and simpler.)
- **Size:** each player is esbuild-bundled (minify + tree-shake, gzip level 9) with
  `babylon-lite-gl` **tree-shaken in**. The stencil player is measured as the two variants it
  actually ships: flat full, and flat shapes-only for eligible vector animations. The sprite
  player retains its shipped feature chunks, so its per-animation cost includes only triggered
  chunks.
- **Same lite-gl for both.** Both players are bundled against the **same** `babylon-lite-gl` source
  (this repo's `master` today, the published `@babylonjs/lite-gl` later) — what each actually ships
  against in production. This isolates the player's own size rather than conflating it with two
  different lite-gl variants.
- **Internal local and public worker delivery.** Every size metric shows both the measurement-only
  local bundle and real production delivery with the worker. For stencil, `⊕w` is the full client +
  full worker, or the shapes client + shapes worker. The sprite worker is measured from the vendored
  source using its shipped feature chunks.
- **Splashscreen.** Vector-only animations also show the internal local shapes harness and the
  public shapes-only worker delivery (`⊕w`) — the smallest way to ship a splashscreen.
- **Perf:** headed Chrome, RAF-callback CPU timing (Potential FPS = 1000 / RAF-avg), draw calls
  counted at the GL boundary, init time, time-to-first-frame, and JS-heap memory.
- **Capability gating:** the sprite player **cannot** represent images, morphs, masks, or mattes. Those
  animations are marked **n/a** for sprite (not just "slow") so the dashboard never shows a
  misleadingly-good number for a broken render.

### Measurement file map (`measure/`)

| File                                               | Role                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `size-lib.mjs`                                     | **Single source of truth** for sizing: full/shapes stencil artifacts, sprite feature chunks, and worker clients.                              |
| `bench/run.mjs`                                    | The one-command orchestrator (`pnpm measure`): size + perf → `dashboard.html` + `results.json`.                                               |
| `bench/perf.mjs`                                   | The Playwright perf driver (per-rendered-frame fairness, draw-call counting).                                                                 |
| `bench/dashboard.mjs`                              | Renders the self-contained HTML dashboard.                                                                                                    |
| `full-local.ts`, `shapes-local.ts`                 | Measurement-only flat full and shapes player entries.                                                                                         |
| `worker-full-client.ts`, `worker-shapes-client.ts` | Measurement-only main-thread client entries for full and shapes workers.                                                                      |
| `sprite-entry.ts`                                  | Measurement-only entry for the sprite player (imported from the vendored `vendor/sprite/` source).                                            |
| `vendor/`                                          | Measurement-only sprite reference. Both players build against the same installed lite-gl. See [`vendor/README.md`](measure/vendor/README.md). |

> **The sprite reference is included in-tree.** It lives at `measure/vendor/sprite/`, so
> `pnpm measure` works on any clone. Both players are measured against the same installed
> `@babylonjs/lite-gl`. See [`vendor/README.md`](measure/vendor/README.md) for provenance and
> licensing.

### Test fixtures

Local animation JSONs live in the gitignored [`anims/`](anims/README.md) directory. Drop any Lottie
`*.json` files you are licensed to test there and the demo + bench pick them up. The demo also
bundles two synthetic fixtures (`_stroketest`, `_masktest`) that need no external files.

### Visual regression tests

Blocking visual tests use only the hand-authored Apache-2.0 fixtures under
`tests/visual/fixtures/`. They do not read `anims/` and do not depend on the Babylon Assets CDN.
Normal runs build and exercise the published `dist` standalone API plus its full/shapes workers,
then compare their canvases with reviewed goldens:

```powershell
pnpm build:lottie-player
pnpm test:visual:lottie-player
```

Build first: the visual runner intentionally consumes the existing `dist` and does not rebuild it,
so it cannot clobber release-versioned output prepared by the publish pipeline.

Goldens are generated locally from the installed Babylon.js Lottie player where it supports the
feature, or from the installed `lottie-web` canvas renderer for masks, mattes, morphs, and images.
They are never generated from the candidate renderer. Only regenerate them for an intentional
fixture/reference change, and inspect every image before keeping it:

```powershell
pnpm build:lottie-player
node packages/babylon-lottie-player/tests/visual/update-goldens.mjs
```

The Playwright configuration uses Playwright's pinned full Chromium channel because its ANGLE
WebGL2 stencil behavior matches production Chrome; the lightweight headless shell does not render
this stencil pipeline reliably. CI installs that pinned Chromium build and uses SwiftShader for a
deterministic software-GPU run; local golden review uses the machine's real GPU.

---

## Demo tooling (`demo/`)

- `serve.mjs` — live viewer (`pnpm demo`, port 5180). Dropdowns for **Animation**, **Renderer**
  (Full / Shapes), and **Thread** (Main / Worker).
- `screenshot.mjs` — headed-Chrome screenshots for visual validation:
  `node demo/screenshot.mjs <name[@t]>…` (e.g. `myanim@0.5`). Honors `THREAD=worker` and
  `RENDERER=shapes` env vars.
- `build.mjs` / `_shared.mjs` — esbuild config (bundles the viewer plus the two worker entries).
- `analyze.mjs` — prints layer/item/mask counts for an animation.

---

## Status

**Implemented:** fills, solids, linear/radial gradients with animated colors, butt/round-cap strokes
with round joins, add-mode masks, opaque vector alpha track mattes, text, images, morphing paths,
hidden layers, nested group transforms, MSAA, z-order, comp clipping, and parent transforms — in
the internal main-thread harness and public worker delivery.

**Not yet supported:** mask subtract/intersect/inverted/feather, inverted/luma/fractional-alpha
track mattes, square stroke caps, non-round stroke joins, even-odd fill rules, independent gradient opacity-stop
offsets, time stretch, precompositions, `mergePaths`, `trimPath`, per-glyph text animators, and
gradient strokes.

The source manifest remains `private` to prevent accidental publication from the repository root.
The release pipeline builds and publishes the generated `dist/` package, including root,
`./shapes`, `./standalone`, the classic standalone client, the fixed shapes splash pair, and both
prebuilt workers.
