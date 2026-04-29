# PR 1 — Pure 2D Sprites — Scope

> **Source spec:** [`architecture/26-sprites.md`](architecture/26-sprites.md)
> **Parent plan:** [`sprites-implementation-plan.md`](sprites-implementation-plan.md)
> **Branch:** `lite-2d`
> **Status:** shipped

## Purpose

This document is a **focused, minimal scope** for the first sprite PR. It
intentionally narrows 26-sprites.md's full surface down to the smallest slice
that puts sprites on screen with no `Scene` involvement. Everything deferred
here lands in later PRs (see the Deferred section at the end).

## Acceptance criteria (must all pass for PR 1 to merge)

> **Note:** `scene50-sprite-grid` is the BJS-validated parity scene that covers PR 1, and the pure-2D bundle ceiling (forbidding `scene/scene-core.js`) is asserted on scene50.

1. `pnpm test:parity` green — all existing 36 parity scenes still pass byte-identical.
2. Parity scene `scene50-sprite-grid` passes its golden screenshot.
3. `tests/parity/bundle-size.spec.ts` green — including the **pure-2D ceiling on scene50** that forbids `scene/scene-core.js` from the bundle.
4. New vitest: `sprite-renderer.test.ts` passes (create / register / unregister / dispose + pipeline-cache size check).
5. `pnpm build:bundle-scenes` succeeds.
6. `npm run format:check` and `npm run lint:check` green.
7. No changes to `reference/` goldens (the new scene's reference is added, not modified).

## Constraints — DO NOT TOUCH

- `packages/babylon-lite/src/engine/engine.ts` — the `RenderingContext` interface and `_renderingContexts` plumbing ship in master via `fe94005`. Consume as-is.
- `packages/babylon-lite/src/scene/**` — PR 1 must not import anything from `scene/`. Pure-2D = no scene.
- Any existing parity scene (`scene-config.json` entries 1–35 + 40, all `.spec.ts` files, all `lab/src/lite/sceneN.ts`).
- Existing bundle ceilings in `scene-config.json` (`maxRawKB` on scenes 1–35, 40).

## New files

### Package code

```
packages/babylon-lite/src/sprite/
  sprite-renderer.ts            // SpriteRenderer + RenderingContext impl + WGSL + pipeline cache
  sprite-2d.ts                  // Sprite2DLayer + Index API (add/update/remove/setFrame)
  shared/
    sprite-atlas.ts             // SpriteAtlas + createGridSpriteAtlas + loadSpriteAtlas (grid-only)
```

**No** `sprite-animation.ts`, **no** `sprite-2d-handle.ts`, **no** `anchor/`, **no** billboard files. Those are later PRs.

### Lab & tests

```
lab/src/lite/scene50.ts                      // pure-2D demo
lab/scene50.html                             // page
lab/bundle-scene50.html                      // bundle measurement page
lab/public/thumbnails/scene50.png            // optional, can be placeholder
lab/public/sprites/                          // (or reuse existing assets path)
  atlas.png                                  // 128×128 grid atlas, 4×4 cells of 32×32
tests/parity/scenes/scene50-pure-2d-sprites.spec.ts
packages/babylon-lite/test/sprite/
  sprite-renderer.test.ts                    // vitest
reference/scene50-pure-2d-sprites/
  babylon-ref-golden.png                     // our render is the golden (no BJS reference)
```

### Config

- Add scene50 entry to `scene-config.json` with `maxRawKB`, `maxMad`.
- No `maxRegionMad` (scene is entirely sprite content; full-image MAD is the right metric).

## Public API — exact signatures

**Add these to `packages/babylon-lite/src/index.ts`:**

```ts
// Sprite atlas (shared foundation)
export type { SpriteAtlas, SpriteFrame, SpriteSampling, GridAtlasOptions, LoadAtlasOptions } from "./sprite/shared/sprite-atlas.js";
export { createGridSpriteAtlas, loadSpriteAtlas } from "./sprite/shared/sprite-atlas.js";

// Sprite 2D layer + Index API
export type { Sprite2DLayer, Sprite2DLayerOptions, Sprite2DProps, Sprite2DView, Sprite2DDepthMode, SpriteBlendMode } from "./sprite/sprite-2d.js";
export { createSprite2DLayer, addSprite2DIndex, updateSprite2DIndex, removeSprite2DIndex, setSprite2DFrameIndex } from "./sprite/sprite-2d.js";

// Sprite renderer
export type { SpriteRenderer, SpriteRendererOptions } from "./sprite/sprite-renderer.js";
export { createSpriteRenderer, registerSpriteRenderer, unregisterSpriteRenderer, disposeSpriteRenderer } from "./sprite/sprite-renderer.js";
```

## Minimized surface for PR 1

The full spec in 26-sprites.md describes a rich system. PR 1 ships **only this subset**:

### `SpriteAtlas`

- Exactly as specified in 26-sprites.md lines 451–467, **with names omitted** — see decision note below.
- `loadSpriteAtlas(engine, url, options)` — **grid-only** in PR 1. `options.gridSize` required; `metadataUrl` path throws "not implemented in PR 1".
- `createGridSpriteAtlas(texture, options)` — full implementation.
- `resolveSpriteFrame(atlas, index)` — internal index-only bounds check used by the layer API; not exported from the public barrel.
- `clips` field on atlas — **removed from PR 1**. Originally planned as a forward-compat empty-array placeholder; dropped to keep the surface honest. Will return as an additive change to `SpriteAtlas` when sprite clip animation lands (see "Deferred follow-ups" below).

#### Decision: frame names live in a wrapper, not in `SpriteAtlas`

The original spec proposed `SpriteFrameRef = number | string` and a `_frameByName` lookup
baked into every atlas. PR 1 ships **integer frame indices only**:

- `SpriteAtlas` carries no `_frameByName` / `_clipByName` maps.
- `Sprite2DProps.frame` is `number | undefined`; same for `setSprite2DFrameIndex`.
- `createNamedSpriteAtlas` is **not exported** (was a forward-compat stub; deleted).

When the TexturePacker JSON loader lands, names will be added via a wrapper type
(working name `NamedSpriteAtlas`) that holds a base `SpriteAtlas` plus a
`Map<string, number>` and exposes `resolveByName(name): number`. Callers translate
name → index at the boundary and the engine's hot path stays a pure integer lookup.
Rationale: the `typeof` branch in `resolveSpriteFrame` was paid by every grid-atlas
caller for a feature they don't use, and the engine doesn't need to own the name table.

### `Sprite2DLayer` + Index API

- All fields on `Sprite2DLayer` per spec lines 561–572.
- `Sprite2DLayerOptions.depth` — **accept `"none"` only**. Throw on `"test"` / `"test-write"` with a clear "depth-hosted sprites land in PR 3" message.
- `Sprite2DLayerOptions.view` — accept but **view is applied in PR 1** (pan/zoom works; see Visual Proof).
- `blendMode` — support `"alpha"` and `"premultiplied"` only. Throw on `"additive"`/`"multiply"`/`"cutout"` with "lands in a later PR" message.
- `addSprite2DIndex` / `updateSprite2DIndex` / `removeSprite2DIndex` / `setSprite2DFrameIndex` — full PR 1 implementation.
- `playSprite2DClipIndex` / `stopSprite2DClipIndex` — **not in PR 1**. Not exported.
- `pickable` field on `Sprite2DProps` — accept in types, no-op (picking is PR 5).
- `clip` field on `Sprite2DProps` — accept in types, no-op (clips are a later PR).

### `SpriteRenderer`

- `RenderingContext` shape implemented directly:
    - `_drawCallsPre: 0` (sprites have no pre-pass work in PR 1).
    - `clearColor` — from `opts.clearValue` or default `{ r: 0, g: 0, b: 0, a: 1 }`.
    - `_update(encoder, deltaMs)` — uploads dirty per-instance data to the GPU instance buffer, returns encoder unchanged.
    - `_record(pass)` — sorts layers by `(order, insertion)`, binds pipeline + atlas bind group per layer, issues one `drawIndexed(6, instanceCount)` per layer. Returns total draw calls.
- `SpriteRendererOptions`:
    - `layers` required.
    - `clearValue` optional (default `{ r: 0, g: 0, b: 0, a: 1 }`).
    - **Off-screen / per-renderer attachment options (`target`, `depthView`, `resolveTarget`, `loadOp`, `sampleCount`) are intentionally not on this interface in PR 1.** The renderer draws into the engine's shared pass (same as scenes), so these fields would be dead weight today. They will be added back when HUD-to-offscreen / per-context MSAA / depth-hosted rendering land — see the deferred-items table below.
- `createSpriteRenderer(engine, opts)` — constructs the renderer, builds the pipeline for the one `(sampleCount=engineMsaa, hasDepth=false)` key.
- `registerSpriteRenderer(sr)` — pushes onto the renderer's engine `_renderingContexts`. Idempotent (double-register is a no-op).
- `unregisterSpriteRenderer(sr)` — splices out of the renderer's engine.
- `disposeSpriteRenderer(sr)` — unregisters, destroys pipeline cache contents (buffers, pipelines), and clears `layers`.

### WGSL

- Single shader. Vertex: reads instance data (positionPx, sizePx, uvMin, uvMax, rotation, color) + layer UBO (view, screen size, pivot, opacity). Fragment: samples atlas, multiplies by color, applies opacity. Pivot is per-layer (in the UBO) for PR 1; per-sprite / per-frame override is deferred.
- Pipeline cache: `Map<number, GPURenderPipeline>` keyed on `(sampleCount << 8) | (blendMode << 4) | (hasDepth ? 1 : 0)`. PR 1 will only populate two keys: alpha / premultiplied, both with hasDepth=0 and engine's MSAA.
- Index buffer: 6 indices `[0,1,2, 0,2,3]`, one per engine, shared across sprite layers.
- Vertex shader uses `@builtin(vertex_index)` for the quad corner; no vertex buffer for positions.
- Per-instance struct (std430, tightly packed): 48 bytes (positionPx.xy, sizePx.xy, uvMin.xy, uvMax.xy, rotation, \_pad, color.xyzw). `@vertex` reads via `@location(N)`.

## Visual proof — scene50-pure-2d-sprites

**What the scene renders:**

- Canvas 800 × 600.
- Solid background: `clearValue = { r: 0.10, g: 0.12, b: 0.18, a: 1.0 }` (dark blue).
- One `SpriteAtlas` loaded from `lab/public/sprites/atlas.png` (128×128, 4×4 grid of 32×32 cells).
- One `Sprite2DLayer`, `depth: "none"`, `blendMode: "alpha"`.
- Five static sprites placed at fixed pixel coordinates:
    1. `{ positionPx: [100, 100], sizePx: [64, 64], frame: 0 }`
    2. `{ positionPx: [200, 150], sizePx: [64, 64], frame: 1 }`
    3. `{ positionPx: [300, 200], sizePx: [128, 128], frame: 2, rotation: 0.3 }`
    4. `{ positionPx: [500, 300], sizePx: [64, 64], frame: 3, color: [1, 0.5, 0.5, 1] }` (tinted)
    5. `{ positionPx: [650, 450], sizePx: [96, 96], frame: 0, flipX: true }`
- Layer `view: { positionPx: [0, 0], zoom: 1.0, rotation: 0 }` — identity.

**Atlas `atlas.png`:** simple programmer-art — 4×4 grid of 32×32 cells, each cell a distinct solid color with a 1-pixel black border (easy to verify framing). Can be authored with a tiny throwaway Node script or by hand. Commit it.

**Determinism:** scene is fully static (no animation, no input). Golden capture is stable.

**Skeleton** (`lab/src/lite/scene50.ts`):

```ts
import { createEngine, startEngine, loadSpriteAtlas, createSprite2DLayer, addSprite2DIndex, createSpriteRenderer, registerSpriteRenderer } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const atlas = await loadSpriteAtlas(engine, "/sprites/atlas.png", { gridSize: [32, 32] });

    const layer = createSprite2DLayer(atlas, { blendMode: "alpha", depth: "none" });
    addSprite2DIndex(layer, { positionPx: [100, 100], sizePx: [64, 64], frame: 0 });
    addSprite2DIndex(layer, { positionPx: [200, 150], sizePx: [64, 64], frame: 1 });
    addSprite2DIndex(layer, { positionPx: [300, 200], sizePx: [128, 128], frame: 2, rotation: 0.3 });
    addSprite2DIndex(layer, { positionPx: [500, 300], sizePx: [64, 64], frame: 3, color: [1, 0.5, 0.5, 1] });
    addSprite2DIndex(layer, { positionPx: [650, 450], sizePx: [96, 96], frame: 0, flipX: true });

    const sr = createSpriteRenderer(engine, {
        layers: [layer],
        clearValue: { r: 0.1, g: 0.12, b: 0.18, a: 1.0 },
    });
    registerSpriteRenderer(sr);

    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
```

## Tests

### `tests/parity/scenes/scene50-pure-2d-sprites.spec.ts`

Model on `scene1-boombox.spec.ts` but:

- No BJS reference (`captureGolden` is skipped; golden is ours).
- Compare full-image MAD only (no region).
- Initial run: golden is generated once, committed, then asserted against.

### `tests/parity/bundle-size.spec.ts`

- scene50's entry in `scene-config.json` carries `maxRawKB`. Set it ~5 KB above first measured baseline.
- **Additional assertion in the existing test loop:** if `scene.slug === "scene50-pure-2d-sprites"`, assert that **no file** matching `/scene-core|scene-camera|scene-node|asset-container/` appears in `jsPayloads`. This is the pure-2D ceiling.

### `packages/babylon-lite/test/sprite/sprite-renderer.test.ts` (vitest)

Cases (each uses a stub engine / mocked `GPUDevice`; follow the pattern of existing unit tests under `test/`):

1. `createSpriteRenderer` returns an object with `_kind === "sprite-renderer"` and `_update` + `_record` methods.
2. `registerSpriteRenderer` pushes onto `engine._renderingContexts`; second call is a no-op (length stays +1).
3. `unregisterSpriteRenderer` splices it out (length returns to original).
4. `disposeSpriteRenderer` sets `layers.length = 0` and destroys internal GPU resources (assert via mock destroy counters).
5. Pipeline cache holds ≤ 2 entries after adding two layers with different `blendMode`s (alpha + premultiplied).
6. Throws when a layer has `depth: "test"` or `"test-write"` (PR 3 territory).

**Skip for PR 1:** actual GPU-render unit tests — the parity scene covers end-to-end. Unit tests stay pure-CPU.

## Deferred to later PRs (explicitly OUT of PR 1)

| Item                                                                                                                                                  | Lands in                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `addToScene` `"sprite-2d-layer"` branch                                                                                                               | PR 2                                         |
| `_hudSpriteLayers` bucket + auto-HUD registration                                                                                                     | PR 2                                         |
| `depth: "test"` / `"test-write"`                                                                                                                      | PR 3                                         |
| Depth-hosted routing into `_opaqueRenderables`                                                                                                        | PR 3                                         |
| Billboards (anchored / camera-facing)                                                                                                                 | PR 4                                         |
| `AnchorSource` adapter                                                                                                                                | PR 4                                         |
| Sprite picking                                                                                                                                        | PR 5                                         |
| `Sprite2DHandle` + `BillboardSpriteHandle`                                                                                                            | PR 6                                         |
| Named atlases (frame-by-name wrapper)                                                                                                                 | with TexturePacker loader                    |
| Sprite clip animation (re-adds `SpriteClip` interface + `clips` field on `SpriteAtlas`; both were dropped from PR 1 to keep the surface honest)       | later                                        |
| `blendMode` additive/multiply/cutout                                                                                                                  | later                                        |
| `pixelSnap` option/property (omitted from PR 1 API until the renderer/shader actually snaps transformed positions)                                    | later                                        |
| Per-sprite / per-frame `pivot` override (PR 1 ships per-layer pivot only)                                                                             | later                                        |
| `SpriteRendererOptions.target` / `depthView` / `resolveTarget` / `loadOp` / `sampleCount` (off-screen / per-renderer attachments + per-renderer MSAA) | PR 2 – PR 4 (HUD-to-offscreen, depth-hosted) |
| `order` interaction across multiple layers                                                                                                            | PR 2 or later (PR 1 has one layer)           |

## Open questions (resolve during implementation, don't block)

1. **WGSL coordinate system.** Pixel coordinates → NDC conversion in vertex shader. Use `(px / screenSize) * 2 - 1` with Y-flip (pixels are top-down, NDC is bottom-up). Verify with programmer-art atlas.
2. **Atlas premultiplied-alpha.** `loadSpriteAtlas` should force `premultipliedAlpha: true` for PNG (browser decode default) and set the corresponding blend state on the pipeline.
3. **Engine MSAA.** `createEngine` currently picks an MSAA sample count. Verify `engine.msaaSamples` is readable by `SpriteRenderer` at creation time so the pipeline is built for the right key.
4. **Target size for view.** The layer's `view` transform needs to know the render target size. Read from `engine._targets.width/height` per frame? Or via a `_update` call?
5. **Resolved target in `_record`.** `RenderingContext._record(pass)` doesn't receive the target size. Confirm how existing scenes access target dimensions in `_record` and follow the same pattern.

## What "done" looks like

One commit (or a small, obviously-related series) on `lite-2d` that:

- Adds the files listed above.
- Exports the listed public API.
- Passes `pnpm test` (build:bundle-scenes + test:parity).
- Adds the new bundle ceiling without changing any existing one.
- Does not touch `reference/` goldens for scenes 1–35 / 40.
- Passes format + lint.
- Leaves `sprites-implementation-plan.md` updated: PR 1 row marked `✅ shipped in <commit>`.
