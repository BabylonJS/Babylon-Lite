# Module: Sprites

> Package path: `packages/babylon-lite/src/sprite/`
>
> This is the standalone, one-shot architecture document for the sprite
> module. Two sprite families are defined: `Sprite2DLayer` (the
> foundation; pixel-coordinate quads, with an opt-in world-anchor adapter
> for "2.5D" labels) and `*BillboardSpriteSystem` (world-coordinate,
> perspective-correct, camera-oriented quads in three orientation
> variants).
>
> The engine grows a small registration list. Two kinds of things implement
> `RenderingContext` and can be registered with an engine: a `SceneContext`
> (via `registerScene(engine, scene)`) and a `SpriteRenderer` (via
> `registerSpriteRenderer(sr)`). Each is driven once per frame by
> `startEngine(engine)` in registration order. Pure-2D experiences
> (Lottie/Rive-class apps) create one or more `SpriteRenderer`s and
> register them on the engine — no `SceneContext`, no `addToScene`.
> HUD-on-3D apps register a `SceneContext` first, then construct a
> separate `SpriteRenderer` for the HUD layers and register it after the
> scene so it draws on top; the HUD's GPU lifetime is tied to the scene
> via `onSceneDispose(scene, () => disposeSpriteRenderer(hud))`.
> Depth-hosted `Sprite2DLayer`s (those with `depth: "test" | "test-write"`)
> are added through `addDepthHostedSpriteLayer(scene, layer)`. That opt-in
> sprite module function registers a deferred scene builder; because callers
> explicitly import this function when they want scene-hosted sprites, its
> static `sprite-renderable` import is limited to that opt-in graph. The
> builder inserts a generic `Renderable` into the scene, and the frame graph
> then buckets it alongside meshes by `isTransparent` / `isTransmissive`.
>
> This document contains the full specification needed to implement the
> module from scratch — public API, internal architecture, GPU layouts,
> WGSL composers, picking contributors, lifecycle, handles, parenting,
> tests, and bundle ceilings. No prior sprite design document is
> required for context.

## Purpose

Lite's design rule is "build things on top of previous things." Sprites are
2D quads. World-anchored ("2.5D") labels are 2D quads whose pixel position
is computed each frame from a 3D anchor. Camera-facing world-sized
billboards are different geometry (world-unit size, perspective
foreshortening, depth participation), and so they remain a separate family.

The module exposes **two** sprite families:

1. **`Sprite2DLayer`** — the foundation. Pixel-coordinate quads, no view
   matrix, no perspective divide, no required camera. Each layer chooses
   its depth participation at construction (`depth: "none" | "test" | "test-write"`),
   which becomes part of the pipeline cache key. The same layer factory
   serves three callers:
    - **Pure-2D apps** (no scene): layers are handed to a `SpriteRenderer`
      that the caller constructs and registers on the engine.
    - **HUD overlays** on a 3D scene: same — a `SpriteRenderer` constructed
      by the caller, registered after the scene, with disposal tied to the
      scene via `onSceneDispose`. HUD layers (`depth: "none"`) **never**
      go through `addToScene`.
    - **Depth-hosted sprites** that sort against 3D meshes
      (`depth: "test"` or `"test-write"`): added via
      `addDepthHostedSpriteLayer(scene, layer)`. That opt-in function queues
      them into the existing renderable system so they
      participate in the 3D depth attachment.

    World-anchored sprites are not a separate family. They are
    `Sprite2DLayer` sprites with an opt-in `AnchorSource` adapter that runs
    on the CPU in a per-frame `_beforeRender` hook, projects the world
    anchor through the scene's camera, and writes the resulting layer-space
    `positionPx` (and optionally a derived per-instance `z`) directly into
    the same per-instance slot a pure-2D sprite uses. The vertex shader,
    per-instance layout, packed buffer, and pipeline are **identical** to a
    pure-2D layer.

2. **`*BillboardSpriteSystem`** — three orientation factories
   (`Facing`, `YawLocked`, `AxisLocked`), each with its own WGSL composer,
   pipeline, and dynamic-import chunk. World-coordinate quads, world-unit
   size, perspective foreshortening, full depth participation. Drawn
   inside the scene's 3D pass; not usable from the pure-2D path (no
   camera).

`SpriteAtlas`, `SpriteFrame`, `SpriteClip`, `SpriteClipState`, the per-clip
animation tick, the handle/index two-tier API, and parenting are all shared
across both families and orthogonal to family.

### Pillars (front and centre)

- **No `if` on render path.** Family selection, anchor mode, and depth
  mode are all decided at layer/system construction time and baked into
  the pipeline cache key. The per-frame draw walks fixed arrays, with
  no per-sprite mode test.
- **Pay-for-use.** A pure-2D app's static import graph terminates at
  `engine` + `sprite-atlas` + `sprite-animation` + `sprite-2d` +
  `sprite-renderer`. It never imports `scene-core`, `Camera`, `Mesh`,
  `LightBase`, `Sprite3DSceneUBO`, depth/MSAA targets, billboard
  variants, or anchor projection code. Tree-shaking removes them all.
- **One engine loop, two registerable kinds.** `startEngine(engine)`
  walks `engine._renderingContexts` once per frame. Pure-2D apps
  register one or more `SpriteRenderer`s; HUD-on-3D apps register a
  `SceneContext` followed by a separate `SpriteRenderer` for the HUD.
  Depth-hosted Sprite2D layers go through `addDepthHostedSpriteLayer` and
  are drawn inside the scene's 3D pass via the existing renderable system. The
  engine has no notion of "2D vs 3D" — it just iterates registrations;
  scene contexts execute their frame graph, and sprite renderers open a
  sprite-only swapchain pass.
- **Extensions over hardcoding.** Anchoring is a tree-shakable
  `sprite-anchor.ts` add-on imported only when a scene actually uses
  world anchors. Billboard variants are independent dynamic-import
  chunks; importing one doesn't pull the others.

## Taxonomy — Two Sprite Families

| Family                   | Variants                               | Coordinate space                                         | Size unit   | Depth                                   | Drawn by                                                                                                                                                              |
| ------------------------ | -------------------------------------- | -------------------------------------------------------- | ----------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sprite2DLayer`          | 1 (with optional `AnchorSource`)       | Pixels (layer-space; CPU-projected for anchored sprites) | Pixels      | Configurable per layer (composer-baked) | A `SpriteRenderer` registered on the engine (pure-2D, or HUD-on-3D registered after the scene), or — for `depth: "test" \| "test-write"` layers — the scene's 3D pass |
| `*BillboardSpriteSystem` | 3: `Facing`, `YawLocked`, `AxisLocked` | World                                                    | World units | Read; write configurable                | The scene's 3D pass (no pure-2D path)                                                                                                                                 |

### Why anchored is no longer a family

A naive design would split `Sprite2DLayer` and an `AnchoredSpriteLayer`
into two families because anchored sprites need a `viewProjection` to
project their world anchor, and anchored sprites that should occlude
behind 3D geometry need a depth attachment. That separate-family design
would have its own WGSL composer, its own 112-byte instance stride
(worldPos + offsetPx + depthBias), and its own GPU vertex-stage
projection.

That shape is wrong for three concrete reasons:

1. **The actual difference is one CPU operation per anchored sprite per
   frame.** Project a world anchor through `viewProjection`, divide by `w`,
   scale to viewport pixels, write the result into the same `positionPx[2]`
   slot a pure-2D sprite would use. This is one Mat4 × Vec4 (16 FMAs) plus
   2 multiplies and 2 adds. For typical anchored populations (HUD pins,
   nameplates, map markers — dozens to a few hundred) this is microseconds
   per frame. Doing it on the CPU keeps the GPU pipeline, the per-instance
   layout, the packed buffer stride, and the WGSL vertex shader **byte-
   identical** to a pure-2D layer.

2. **Depth participation is a per-render-pass attachment decision, not a
   per-family decision.** Modelling it as a family leaks a pass-level
   constraint into the layer type and forces the public API to choose one
   shape ("anchored") instead of letting any 2D layer opt into depth
   testing. Modelling it per layer (`depth: "none" | "test" | "test-write"`)
   is the correct level of granularity. Each value is a pipeline-cache key
   bit baked once at composition time — never branched at runtime.

3. **The 3D scene UBO (viewProjection + camera basis + viewport)
   was paid for solely to GPU-project anchors.** Once we project on the
   CPU, anchored layers do not need that UBO at all (the camera basis
   appears only as the `viewProjection` matrix consumed by the CPU
   projection helper, and `viewportPx` already lives in the pure-2D scene
   UBO). The 3D scene UBO becomes a billboard-only artefact, which it
   morally always was.

The "anchor" is a small interface:

```typescript
export interface AnchorSource {
    /** Project this anchor for the current frame.
     *  Writes into outPx (length 2) and outZ (length 1, view-space depth).
     *  Returns false to hide the sprite this frame (off-screen, behind camera, parent not yet built). */
    readonly project: (outPx: Float32Array, outZ: Float32Array, scene: SceneContext) => boolean;
}
```

`AnchorSource` lives in `sprite/anchor/sprite-anchor.ts` — a separate
module. A scene that never instantiates an anchor never imports
`sprite-anchor.ts` and pays zero bytes for camera-basis projection code.

### Why billboards remain a separate family

Billboards are not "Sprite2D + a different anchor source." Their
differences are per-vertex, not per-CPU-update:

- **World-unit sizing.** Billboard quads are extruded in world units along
  camera basis vectors **before** projection (`cameraRight * sizeWorld.x +
cameraUp * sizeWorld.y`), which produces correct perspective
  foreshortening. Anchored sprites are extruded in pixel space **after**
  projection. These are opposite contracts (size shrinks with distance vs.
  size invariant under distance) — the entire reason each variant exists.

- **Per-vertex camera basis.** Each billboard variant computes
  `(right, up)` per vertex from the camera (`Facing`), or from world-up
    - camera direction (`YawLocked`), or from a lock axis + camera direction
      (`AxisLocked`). The pure-2D vertex shader has no camera basis input at
      all and ships zero camera-basis code.

- **Depth-write semantics.** Cutout billboards write depth (so they cast/
  receive against opaque meshes); anchored sprites never write depth.

Forcing billboards through the Sprite2D pipeline would either require a
per-vertex `if (isBillboard) { compute world basis } else { compute pixel
offset }` (violating the no-`if`-on-render-path rule), or a CPU "project
four corners" path (O(N×4) Mat4×Vec4 per frame against tree forests, the
exact cost the billboard vertex-shader trick was invented to avoid).
Splitting them is correct.

The three orientation factories remain explicit (`Facing`, `YawLocked`,
`AxisLocked`) — three vertex shaders, three pipelines, three dynamic-
import chunks, no `axisLock?: 'none'|'y'|Vec3` flag.

### Modes deliberately not added

- **World-aligned non-billboard sprite** — use a `Mesh` with a textured
  alpha-blended material.
- **Tile maps (`SpriteMap`-like)** — separate future module.
- **2D-camera scene with pan/zoom** — that is `Sprite2DLayer.view`
  (per-layer pan + zoom + rotation), no additional family.

## Resolution: One engine loop, two registerable kinds

**Decision: the engine has a single registration list. Two kinds of
things implement `RenderingContext` and can be registered with an
engine: a `SceneContext` (via `registerScene(engine, scene)`) and a
`SpriteRenderer` (via `registerSpriteRenderer(sr)`). `startEngine(engine)`
walks `engine._renderingContexts` once per frame. The engine owns the
command encoder and swapchain view for the frame; each context runs
`_update()` and `_record()` against that current frame state. A
`SceneContext` records through its `FrameGraph` (normally the default
swapchain `RenderPassTask`), while a `SpriteRenderer` opens its own
sprite pass directly on the swapchain. Pure-2D experiences
(Lottie/Rive-class apps) create one or more `SpriteRenderer`s and
register them on the engine — they never touch `SceneContext`. HUD-on-3D
apps register a `SceneContext` first, construct a separate
`SpriteRenderer` for the HUD layers, register it after the scene so it
draws on top, and tie its disposal to the scene via
`onSceneDispose(scene, () => disposeSpriteRenderer(hud))`. Depth-hosted
Sprite2D layers (`depth: "test" | "test-write"`) are added through
`addDepthHostedSpriteLayer`, which registers a deferred builder through the
scene's generic optional-renderable hook. The hook inserts a generic renderable
into the scene so it sorts and composites against 3D meshes inside the scene's
3D pass.**

The `SceneContext` shape, the `addToScene` switch body, and the default
frame graph stay sprite-agnostic. The sprite module does not add a second scene type or an
implicit HUD layer list to `SceneContext`; composition remains explicit
at the engine-registration level.

### Rejected alternatives

| Alternative | Why rejected |\n| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |\n| Add a `Scene2DContext` parallel to `SceneContext` | Two parallel APIs for the same operation. Both kinds of registerable already share `RenderingContext` — no new umbrella type is required. |\n| Force pure-2D apps through `SceneContext` | A Lottie/Rive-class app then carries `SceneContext`'s shape and any per-frame branching it implies. Pure-2D experiences should not pay for scene infrastructure. |\n| Pure-2D users own their own `requestAnimationFrame` loop and call a free `renderSprite2DLayers(engine, layers, target)` function | Two different loop owners (engine for scene-based, user for pure-2D) means two first-frame-ready handshakes, two fixed-delta contracts, two device-loss recovery paths. Making the engine the sole loop owner via `register*` is a smaller surface area and frame-graph-shaped. |\n| Auto-route HUD layers through `addToScene` and have `registerScene` lazily create + register an internal `SpriteRenderer` | Adds bytes to scenes that don't have HUDs (everyone pays for the lazy-init code path), couples the sprite module's lifecycle to the scene module, and makes "what is registered on the engine" non-obvious to the caller. Explicit `createSpriteRenderer + registerSpriteRenderer + onSceneDispose` is three lines of caller code and zero bytes for non-HUD scenes. |\n| Refactor `addToScene` into method-on-entity routing + per-stage wrappers | Public objects must remain pure state; optional scene-hosted systems use standalone add helpers plus the generic deferred-renderable hook instead of attaching behavior to public data. |\n| Extract every sprite GPU detail into the scene render loop | Couples sprite rendering to scene orchestration. Then the pure-2D path either re-implements the GPU draws (forking) or pulls in scene infrastructure to reach them (wasted bytes). |

### The engine's registration list

```typescript
// src/engine/engine.ts — sprite support adds nothing here;
// this is the existing RenderingContext shape that both SceneContext
// and SpriteRenderer implement.

/** A thing that can be registered with an engine and driven once per frame. */
export interface RenderingContext {
    /** Draw calls produced by pre-pass work during `_update` (shadows + pre-passes). */
    _drawCallsPre: number;
    /** Clear color used when this context is the first active one in a frame. */
    clearColor: GPUColorDict;
    /** Per-frame update: beforeRender hooks, shadow + pre-passes, UBO updates. */
    _update(): void;
    /** Record frame work using the engine's current encoder/swapchain view. Returns draw-call count. */
    _record(): number;
}

/** @internal Inside EngineContextInternal: */
//   _renderingContexts: RenderingContext[];

export function registerRenderingContext(engine: EngineContext, context: RenderingContext): boolean;
export function unregisterRenderingContext(engine: EngineContext, context: RenderingContext): boolean;

/** Drive the engine's render loop. Walks _renderingContexts in order, once per frame. */
export function startEngine(engine: EngineContext): Promise<void>;
```

`startEngine` resolves on the first frame after registration completes
successfully. Per-frame the engine acquires the swap-chain view +
creates one command encoder, then stores them on the internal engine
state for the current frame. It calls `_update()` and `_record()` on
each registered context in order. Scene contexts execute their frame
graph tasks; sprite renderers record a sprite-only swapchain pass. There
is no per-frame `if (is2D)` branch; the loop just iterates.

### The `SpriteRenderer`

```typescript
// src/sprite/sprite-renderer.ts
import type { EngineContext, RenderingContext } from "../engine/engine.js";
import type { Sprite2DLayer } from "./sprite-2d.js";

/** Options accepted by `createSpriteRenderer`. */
export interface SpriteRendererOptions {
    /** Layers to draw, in registration order. The renderer also re-sorts internally
     *  by `layer.order` each frame (TimSort is O(n) on already-sorted input). */
    layers: readonly Sprite2DLayer[];
    /** Default true. Set false for HUD overlays so the sprite pass preserves existing scene color. */
    clear?: boolean;
    /** Default `{ r: 0, g: 0, b: 0, a: 1 }`. Used when `clear` is true. */
    clearValue?: GPUColorDict;
}

/** A `SpriteRenderer` — pure data, plugs into `engine._renderingContexts`. */
export interface SpriteRenderer extends RenderingContext {
    readonly _kind: "sprite-renderer";
    /** Renderer-owned layer membership. Use add/remove helpers to mutate. */
    readonly layers: readonly Sprite2DLayer[];
}

export function createSpriteRenderer(engine: EngineContext, opts: SpriteRendererOptions): SpriteRenderer;
export function addSpriteRendererLayer(sr: SpriteRenderer, layer: Sprite2DLayer): void;
export function removeSpriteRendererLayer(sr: SpriteRenderer, layer: Sprite2DLayer): boolean;
export function registerSpriteRenderer(sr: SpriteRenderer): void;
export function unregisterSpriteRenderer(sr: SpriteRenderer): void;
export function disposeSpriteRenderer(sr: SpriteRenderer): void;
```

A `SpriteRenderer` does **not** own persistent color/depth attachments.
During `_record` it opens a sprite-only render pass directly on the
per-frame swapchain view using `sampleCount = 1`, the engine's swapchain
format, and no depth attachment. `clear: false` makes the pass use
`loadOp: "load"`, which is the HUD path after a 3D scene has already
resolved into the swapchain. Pure-2D layers use a 40-byte instance layout
with no Z attribute; depth-hosted layers use the 44-byte layout with
per-instance Z.

Internally `SpriteRenderer._update`:

1. Refreshes cached target dimensions (canvas may have resized).
2. Sorts the renderer-owned layer list in place by `layer.order` (skipped for the
   single-layer case).
3. For each visible non-empty layer: ensures GPU resources exist, writes
   per-instance data and per-layer UBO via `device.queue.writeBuffer`
   only when the data has actually changed (compares against a CPU-side
   shadow of the last bytes written).

Internally `SpriteRenderer._record`:

1. For each visible non-empty layer: looks up (or builds and caches) a
   `GPURenderBundle` that bakes `setIndexBuffer` + `setPipeline` +
   `setBindGroup` + `setVertexBuffer` + `drawIndexed(6, count)`. The
   bundle is rebuilt only when the layer's sprite count changes or its
   instance buffer is reallocated.
2. Replays all visible bundles with one reused `pass.executeBundles(...)` array — skips
   per-call WebGPU validation and IPC, near-zero CPU cost in the steady
   state.

The `SpriteRenderer` is the single home for HUD/pure-2D sprite GPU draw
logic. Depth-hosted Sprite2D layers (`depth: "test" | "test-write"`) do
not go through it — they are drawn by an independent `Renderable`
produced by `sprite-renderable.ts` (see "Caller 2" below).

### Caller 1: pure-2D — no `SceneContext`

A Lottie/Rive-class app never creates a scene. It creates a
`SpriteRenderer`, registers it on the engine, and lets `startEngine`
drive the loop:

```typescript
const engine = await createEngine(canvas);
const atlas = await loadSpriteAtlas(engine, "sprites.png", { gridSize: [32, 32] });
const layer = createSprite2DLayer(atlas);
addSprite2D(layer, { positionPx: [100, 200], sizePx: [64, 64], frame: 0 });

const sr = createSpriteRenderer(engine, {
    layers: [layer],
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
});
registerSpriteRenderer(sr);

await startEngine(engine);
```

The static import graph is exactly: `engine` + `sprite-atlas` +
`sprite-animation` + `sprite-2d` + `sprite-renderer`. Nothing else.
No `SceneContext`, no `addToScene`, no `registerScene`, no `Camera`, no
`Mesh`, no `LightBase`, no depth/MSAA target allocator, no PBR, no
Standard, no shadow generator, no animation-group walker, no anchor
projection, no billboard variants.

Anchored sprites are not supported in this path — there is no camera to
project against. They require the scene-based path below.

### Caller 2: scene-based — `registerScene` + `addToScene` + a separate HUD `SpriteRenderer`

The new `registerScene(engine, scene)` is the scene-side analogue of
`registerSpriteRenderer`. It runs the scene's deferred builders and
registers the scene as a `RenderingContext` on the engine. After that,
`startEngine(engine)` drives the scene each frame just like it drives
any other registered context.

```typescript
export function registerScene(engine: EngineContext, scene: SceneContext): Promise<void>;
export function unregisterScene(engine: EngineContext, scene: SceneContext): void;

/** Register a callback to fire when `disposeScene(scene)` is called.
 *  Used to tie user-owned GPU resources (e.g. a HUD `SpriteRenderer`)
 *  to the scene's lifetime — mirrors `onBeforeRender`. */
export function onSceneDispose(scene: SceneContext, cb: () => void): void;
```

The scene module exposes one generic optional-renderable hook. The sprite
module uses it from `addDepthHostedSpriteLayer`; that opt-in helper statically
imports the sprite-owned renderable builder because calling the helper is the
explicit feature choice:

```typescript
import { buildSpriteRenderable } from "./sprite-renderable.js";

export function addDepthHostedSpriteLayer(scene: SceneContext, layer: Sprite2DLayer): void {
    if (layer.depth === "none") {
        throw new Error('Sprite2DLayer with depth: "none" must be rendered via createSpriteRenderer, not addDepthHostedSpriteLayer.');
    }
    addDeferredSceneRenderables(scene, (engine) => {
        const built = buildSpriteRenderable(engine, layer);
        return { renderables: [built.renderable], dispose: built.dispose };
    });
}
```

`buildSpriteRenderable` rejects `depth: "none"`, because scene renderables
require a depth policy. `addDepthHostedSpriteLayer` performs the same check
before queuing work. HUD layers use `SpriteRenderer` directly.

The existing `"billboard-sprite-system"` branch stays as today (with its
own `_deferredBuild` hook); billboards are pushed into the existing
scene-level renderable arrays.

`registerScene(engine, scene)` does exactly two things: runs each
queued `_deferredBuild` (so depth-hosted sprite renderables are wired
into the scene's `_renderables` list), then calls
`registerRenderingContext(engine, scene)`. **It does not create or
register any HUD `SpriteRenderer`** — HUDs are an explicit caller
concern (see below).

End-to-end (HUD-on-3D scene, mirrors `lab/src/lite/scene52.ts`):

```typescript
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);

addToScene(scene, createDirectionalLight([0, -1, 0]));
addToScene(scene, await loadGltf(engine, "world.glb"));
addToScene(scene, createYawLockedBillboardSystem(treeAtlas));

// Depth-hosted anchored labels: same Sprite2DLayer factory, depth:"test"
// routes it through addDepthHostedSpriteLayer → sprite-renderable, drawn
// inside the scene's 3D pass.
const labels = createSprite2DLayer(labelAtlas, { depth: "test" });
addAnchoredSprite2D(labels, {
    anchor: createWorldAnchor([0, 1.8, 0]),
    sizePx: [128, 32],
    frame: "name-bg",
});
addDepthHostedSpriteLayer(scene, labels);

await registerScene(engine, scene);

// HUD overlay: separate Sprite2DLayer with depth:"none", drawn by a
// separate SpriteRenderer registered AFTER the scene so it draws on top.
// `addToScene` is never called for HUD layers — they have no business
// in the 3D pass.
const hud = createSprite2DLayer(hudAtlas, { depth: "none" });
addSprite2DIndex(hud, { positionPx: [16, 16], sizePx: [200, 32], frame: "score" });
const hudRenderer = createSpriteRenderer(engine, { layers: [hud], clear: false });
registerSpriteRenderer(hudRenderer);
// Tie HUD lifetime to the scene — disposeScene fires this and frees the GPU buffers.
onSceneDispose(scene, () => disposeSpriteRenderer(hudRenderer));

await startEngine(engine);
```

The punch line: **one** `createSprite2DLayer` factory and one public
Index API, with the per-layer instance layout fixed at creation. The
`depth` option chooses which path the layer ends up in:

- `depth: "none"` → caller hands the layer to a `SpriteRenderer` (pure-2D
  or HUD); never goes through `addToScene`. The layer uses a 10-float /
  40-byte instance layout and the pure shader keeps clip-space Z constant.
- `depth: "test" | "test-write"` → caller passes the layer to
  `addDepthHostedSpriteLayer`, which statically imports the depth-hosted
  renderable builder inside the opt-in scene integration module; layer is
  drawn inside the scene's 3D pass and sorts against meshes by per-instance
  Z. The layer uses the 11-float / 44-byte layout with slot [10] exposed to
  the shader as `@location(6) iZ`.

The `addAnchoredSprite2D` helper attaches an `AnchorSource` and ensures
the per-frame projection hook is installed.

---

## Public API Surface

### Shared — Atlas, Frames, Animation

```typescript
// src/sprite/shared/sprite-atlas.ts
import type { EngineContext } from "../../engine/engine.js";
import type { Texture2D, Texture2DOptions } from "../../texture/texture-2d.js";

export type SpriteSampling = "linear" | "nearest";
export type SpriteFrameRef = number | string;

/** A single frame in an atlas. UVs in [0,1]; pivot in [0,1] of the frame. */
export interface SpriteFrame {
    readonly name?: string;
    readonly uvMin: [number, number];
    readonly uvMax: [number, number];
    readonly sourceSizePx: [number, number];
    readonly pivot: [number, number];
}

export interface SpriteClip {
    readonly name: string;
    readonly frames: readonly number[]; // indices into atlas.frames
    readonly fps: number;
    readonly loop: boolean;
}

export interface SpriteAtlas {
    readonly texture: Texture2D;
    readonly textureSizePx: [number, number];
    readonly frames: readonly SpriteFrame[];
    readonly clips: readonly SpriteClip[];
    readonly sampling: SpriteSampling;
    readonly premultipliedAlpha: boolean;
    /** @internal name -> frame index lookup */
    readonly _frameByName: ReadonlyMap<string, number>;
    /** @internal name -> clip index lookup */
    readonly _clipByName: ReadonlyMap<string, number>;
}

export interface GridAtlasOptions {
    cellWidthPx: number;
    cellHeightPx: number;
    columns?: number; // default: floor(textureWidth / cellWidthPx)
    rows?: number; // default: floor(textureHeight / cellHeightPx)
    marginPx?: number;
    spacingPx?: number;
    pivot?: [number, number]; // default [0.5, 0.5]
    sampling?: SpriteSampling;
    premultipliedAlpha?: boolean;
    clips?: readonly SpriteClip[];
}

export interface NamedAtlasOptions {
    sampling?: SpriteSampling;
    premultipliedAlpha?: boolean;
}

export interface LoadAtlasOptions extends NamedAtlasOptions {
    /** Optional URL to a TexturePacker-style JSON. */
    metadataUrl?: string;
    /** Or an inline grid spec. */
    gridSize?: [number, number];
    textureOptions?: Texture2DOptions;
    clips?: readonly SpriteClip[];
}

export function loadSpriteAtlas(engine: EngineContext, textureUrl: string, options?: LoadAtlasOptions): Promise<SpriteAtlas>;
export function createGridSpriteAtlas(texture: Texture2D, options: GridAtlasOptions): SpriteAtlas;
export function createNamedSpriteAtlas(texture: Texture2D, frames: readonly SpriteFrame[], clips?: readonly SpriteClip[], options?: NamedAtlasOptions): SpriteAtlas;
/** @internal */
export function resolveSpriteFrame(atlas: SpriteAtlas, frame: SpriteFrameRef): number;

// src/sprite/shared/sprite-animation.ts

export interface SpriteClipState {
    clipIndex: number;
    elapsedMs: number;
    speed: number;
    playing: boolean;
    loopOverride: boolean | null;
    onEnd?: () => void;
}

export function createSpriteClipState(opts?: Partial<SpriteClipState>): SpriteClipState;
export function evaluateSpriteClip(atlas: SpriteAtlas, state: SpriteClipState): number;
export function advanceSpriteClip(atlas: SpriteAtlas, state: SpriteClipState, deltaMs: number): number;
```

A `SpriteAtlas` is a shared resource: the same atlas may back multiple
layers/systems across one or many scenes. Its `Texture2D` is uploaded
once at `loadSpriteAtlas`. Layers hold a reference; the atlas is released
only when no layer holds it (regular `Texture2D` lifetime).

`SpriteFrame.pivot` is in normalised `[0, 1]` of the frame — `(0.5, 0.5)`
centres the quad on the sprite's anchor. `SpriteClip.frames` is an array
of indices into `atlas.frames`; a clip's `name` resolves through
`atlas._clipByName`. `evaluateSpriteClip` is pure (no advancement);
`advanceSpriteClip` adds `deltaMs * state.speed` to `state.elapsedMs`,
handles loop / one-shot termination, fires `onEnd`, and returns the
current frame index.

### Family 1 — `Sprite2DLayer` (foundation)

```typescript
// src/sprite/sprite-2d.ts
import type { SpriteAtlas, SpriteFrameRef } from "./shared/sprite-atlas.js";
import type { SpriteClipState } from "./shared/sprite-animation.js";

export type SpriteBlendMode = "alpha" | "premultiplied" | "additive" | "multiply" | "cutout";
export type Sprite2DDepthMode = "none" | "test" | "test-write";

export interface Sprite2DView {
    positionPx: [number, number];
    zoom: number;
    rotation: number;
}

export interface Sprite2DLayerOptions {
    capacity?: number;
    blendMode?: SpriteBlendMode;
    opacity?: number;
    visible?: boolean;
    order?: number;
    view?: Partial<Sprite2DView>;
    /**
     * Layer-wide rotation / scaling pivot in normalised sprite-local space
     * (`[0,0]` = top-left, `[0.5, 0.5]` = center, `[1,1]` = bottom-right).
     * Defaults to `[0.5, 0.5]`. Per-sprite pivot is a future PR — most 2D
     * HUD layers want one uniform pivot anyway.
     */
    pivot?: [number, number];
    /**
     * Depth participation:
     *  - "none"        (default) → drawn by a `SpriteRenderer` registered on the engine. Pipeline has no depth attachment; the per-instance layout has no Z slot. HUD overlays must use this mode and live on a `SpriteRenderer` (not on `addDepthHostedSpriteLayer`).
     *  - "test"                  → drawn inside the scene's 3D pass via `addDepthHostedSpriteLayer` with `depthCompare: "less-equal"`, `depthWrite: false`. Sprites occlude behind 3D geometry but do not write depth.
     *  - "test-write"            → drawn inside the scene's 3D pass via `addDepthHostedSpriteLayer` with `depthCompare: "less-equal"`, `depthWrite: true`. Sprites direct-draw after cached opaque meshes and before transparent renderables.
     *  Each value is a pipeline-cache key bit, baked at composition time. No runtime branch.
     *  Pure-2D engines (no scene) can only use `"none"` — they have no depth attachment.
     */
    depth?: Sprite2DDepthMode;
    /**
     * Default per-instance NDC depth (`0` = near, `1` = far) for sprites added to this
     * layer when their `Sprite2DProps.z` is omitted. Only stored and consumed by `depth: "test" |
     * "test-write"` layers; HUD/pure-2D layers use a 10-float layout and allocate no
     * per-instance Z attribute. Defaults to `0.5`. Mutating `layer.layerZ` after
     * sprites have been added does **not** retroactively change them — call
     * `updateSprite2DIndex(layer, idx, { z: … })` to move an existing sprite.
     */
    layerZ?: number;
}

export interface Sprite2DLayer {
    readonly _entityType: "sprite-2d-layer";
    readonly atlas: SpriteAtlas;
    readonly depth: Sprite2DDepthMode;
    readonly blendMode: SpriteBlendMode;
    opacity: number;
    visible: boolean;
    order: number;
    view: Sprite2DView;
    pivot: [number, number];
    /** Default per-instance Z applied to newly added sprites whose `Sprite2DProps.z` is omitted. */
    layerZ: number;
    count: number;
}

export interface Sprite2DProps {
    positionPx: [number, number];
    sizePx?: [number, number];
    /** Atlas-frame index. Pre-resolved at the call site (e.g. via `getSpriteAtlasFrameIndex`). */
    frame?: number;
    rotation?: number;
    color?: [number, number, number, number];
    flipX?: boolean;
    flipY?: boolean;
    visible?: boolean;
    /** Reserved for picking (PR 5). Accepted but unused today. */
    pickable?: boolean;
    /** Reserved for clip animation (later PR). Accepted but unused today. */
    clip?: unknown;
    /**
     * Per-sprite NDC depth (`0` = near, `1` = far). Only consumed by depth-hosted layers
     * (`depth: "test" | "test-write"`); pure-2D / HUD layers ignore it. When omitted on
     * add, defaults to the owning layer's `layerZ` at the moment of insertion. When omitted
     * on update, the sprite's existing Z is preserved.
     */
    z?: number;
}

export function createSprite2DLayer(atlas: SpriteAtlas, opts?: Sprite2DLayerOptions): Sprite2DLayer;

// Index API — low-level, parallels ThinInstance.
export function addSprite2DIndex(layer: Sprite2DLayer, props: Sprite2DProps): number;
export function updateSprite2DIndex(layer: Sprite2DLayer, index: number, patch: Partial<Sprite2DProps>): void;
export function removeSprite2DIndex(layer: Sprite2DLayer, index: number): void;
export function setSprite2DFrameIndex(layer: Sprite2DLayer, index: number, frame: number): void;

// Animation index API (later PR — landed alongside `sprite-animation.ts`).
export function playSprite2DClipIndex(layer: Sprite2DLayer, index: number, clip: string, loop?: boolean): void;
export function stopSprite2DClipIndex(layer: Sprite2DLayer, index: number): void;
```

The Handle API (`addSprite2D` / `removeSprite2D`, returning a
`Sprite2DHandle` with observable fields, stable id, and parenting) lives
in `sprite/sprite-2d-handle.ts` — separately importable so Index-only
scenes do not pull handle code (see [Handles](#handles-identity-and-parenting)).

### `AnchorSource` — opt-in 3D bridge for `Sprite2DLayer`

```typescript
// src/sprite/anchor/sprite-anchor.ts — separate module, dynamic-imported on first use.
import type { Sprite2DLayer, Sprite2DInit } from "../sprite-2d.js";
import type { SceneContext } from "../../scene/scene-core.js";
import type { IWorldMatrixProvider } from "../../scene/parenting.js";

export interface AnchorSource {
    readonly project: (outPx: Float32Array, outZ: Float32Array, scene: SceneContext) => boolean;
}

/** Static world-space anchor. */
export function createWorldAnchor(worldPos: [number, number, number]): AnchorSource;

/** World anchor that follows a moving entity (mesh, transform node, sprite handle). */
export function createParentAnchor(parent: IWorldMatrixProvider, localOffset?: [number, number, number]): AnchorSource;

/** Attach an AnchorSource to a sprite. The sprite's positionPx is overwritten each frame
 *  by the projection result. Layer must have depth !== "none" for occlusion against 3D geometry. */
export interface AnchoredSprite2DInit extends Sprite2DInit {
    anchor: AnchorSource;
    offsetPx?: [number, number];
    /** NDC-z bias added after projection (positive = pushed toward camera). Default 0. */
    depthBias?: number;
}

export function addAnchoredSprite2D(layer: Sprite2DLayer, init: AnchoredSprite2DInit): number;
export function setSprite2DAnchor(layer: Sprite2DLayer, index: number, anchor: AnchorSource | null): void;
```

The first call to `addAnchoredSprite2D` (or `setSprite2DAnchor` with a
non-null anchor) on a given layer:

1. Lazy-allocates a sparse `Map<number, AnchoredEntry>` on the layer
   (sprites without an anchor have no entry).
2. Installs a per-frame hook into `scene._beforeRender` (via `unshift`,
   so it runs before user `onBeforeRender` callbacks) that walks the
   layer's anchored map, calls each `anchor.project()`, and writes the
   resulting `positionPx`, optional `layerZ` (mapped from view-Z), and
   `depthBias`-adjusted ordering into the layer's flat storage via the
   same code path `updateSprite2DIndex` uses. Sprites whose `project`
   returns `false` get `sizePx = [0, 0]` written into their slot
   (degenerate quad — same trick as `visible: false`).
3. Registers a single disposable that removes the hook when the layer is
   disposed or its anchored map becomes empty.

```typescript
// In sprite-anchor.ts internal:
interface AnchoredEntry {
    anchor: AnchorSource;
    offsetPx: [number, number];
    depthBias: number;
}
```

A scene that has zero anchored sprites never imports `sprite-anchor.ts`,
never allocates the sparse map, never installs the projection hook, and
never pays for `viewProjection` on the CPU.

### Family 2 — `*BillboardSpriteSystem`

```typescript
// src/sprite/billboard/sprite-billboard-shared.ts
import type { SpriteAtlas, SpriteFrameRef } from "../shared/sprite-atlas.js";
import type { SpriteBlendMode } from "../sprite-2d.js";
import type { SpriteClipState } from "../shared/sprite-animation.js";

export interface BillboardSpriteSystemOptions {
    capacity?: number;
    blendMode?: SpriteBlendMode;
    opacity?: number;
    visible?: boolean;
    order?: number;
    depthWrite?: boolean;
    alphaCutoff?: number;
}

export interface BillboardSpriteSystem {
    readonly _entityType: "billboard-sprite-system";
    readonly atlas: SpriteAtlas;
    blendMode: SpriteBlendMode;
    opacity: number;
    visible: boolean;
    order: number;
    depthWrite: boolean;
    alphaCutoff: number;
    count: number;
}

export interface BillboardSpriteInit {
    position: [number, number, number];
    sizeWorld: [number, number];
    frame?: SpriteFrameRef;
    rotation?: number;
    pivot?: [number, number];
    color?: [number, number, number, number];
    flipX?: boolean;
    flipY?: boolean;
    visible?: boolean;
    pickable?: boolean;
    clip?: SpriteClipState | null;
}

export function createFacingBillboardSystem(atlas: SpriteAtlas, opts?: BillboardSpriteSystemOptions): BillboardSpriteSystem;
export function createYawLockedBillboardSystem(atlas: SpriteAtlas, opts?: BillboardSpriteSystemOptions): BillboardSpriteSystem;
export function createAxisLockedBillboardSystem(atlas: SpriteAtlas, axis: [number, number, number], opts?: BillboardSpriteSystemOptions): BillboardSpriteSystem;

// Index API — low-level, parallels ThinInstance.
export function addBillboardSpriteIndex(system: BillboardSpriteSystem, init: BillboardSpriteInit): number;
export function updateBillboardSpriteIndex(system: BillboardSpriteSystem, index: number, patch: Partial<BillboardSpriteInit>): void;
export function removeBillboardSpriteIndex(system: BillboardSpriteSystem, index: number): void;
export function setBillboardSpriteFrameIndex(system: BillboardSpriteSystem, index: number, frame: SpriteFrameRef): void;
export function playBillboardSpriteClipIndex(system: BillboardSpriteSystem, index: number, clip: string, loop?: boolean): void;
export function stopBillboardSpriteClipIndex(system: BillboardSpriteSystem, index: number): void;

// Handle API — observable + parentable, returns BillboardSpriteHandle.
// Lives in src/sprite/billboard/sprite-billboard-handle.ts (separate module so
// Index-only scenes never load handle code).
export function addBillboardSprite(system: BillboardSpriteSystem, init: BillboardSpriteInit): BillboardSpriteHandle;
export function updateBillboardSprite(handle: BillboardSpriteHandle, patch: Partial<BillboardSpriteInit>): void;
export function removeBillboardSprite(handle: BillboardSpriteHandle): void;
export function setBillboardSpriteFrame(handle: BillboardSpriteHandle, frame: SpriteFrameRef): void;
export function playBillboardSpriteClip(handle: BillboardSpriteHandle, clip: string, loop?: boolean): void;
export function stopBillboardSpriteClip(handle: BillboardSpriteHandle): void;
```

Each billboard factory's `_deferredBuild` callback (registered through
`addToScene`'s existing `"billboard-sprite-system"` branch) pushes the
system into the scene's `ctx._billboardSystems` array and queues the
renderable build. The first billboard added also lazy-allocates the
shared 3D scene UBO (`ctx._sprite3dSceneUBO`) and registers its updater.
Pure-2D scenes never reach this code — they don't import `addToScene`,
let alone register a billboard system.

### Picking — two pickers, not three

```typescript
// src/sprite/picking/pick-sprite-2d.ts — handles every Sprite2DLayer
// reachable from the scene (depth-hosted layers added via addToScene)
// AND the layers of any SpriteRenderer the caller hands in.
export function pickSprite2D(layers: ReadonlyArray<Sprite2DLayer>, xPx: number, yPx: number): SpritePickInfo | null;

// src/sprite/picking/pick-billboard.ts — GPU contributor.
export function pickBillboardSprite(scene: SceneContext, xPx: number, yPx: number): Promise<SpritePickInfo | null>;
```

`pickSprite2D` is the pure-2D picker: the caller passes whichever
`Sprite2DLayer` array it owns — `spriteRenderer.layers` for HUD overlays,
or `scene._renderables` (filtered to the Sprite2D `Renderable`s that
`addToScene` pushed there).
The picker iterates in reverse insertion order and, for each candidate
sprite, rotates the screen point into its pivot-aware local rectangle.
For anchored layers `positionPx` has already been projected CPU-side
this frame, so the picker hits the same screen rectangle the GPU draws.
No GPU pick pass for Sprite2D.

`pickBillboardSprite` is a GPU pick contributor; the full design is
specified under [Picking](#picking) below.

### Pure-2D usage — no scene

A pure-2D app skips the scene entirely. It creates a `SpriteRenderer`,
registers it on the engine, and lets `startEngine` drive the loop:

```typescript
import { createEngine, loadSpriteAtlas, createSprite2DLayer, addSprite2D, createSpriteRenderer, registerSpriteRenderer, startEngine } from "babylon-lite";

const engine = await createEngine(canvas);
const atlas = await loadSpriteAtlas(engine, "sprites.png", { gridSize: [32, 32] });
const layer = createSprite2DLayer(atlas);
addSprite2D(layer, { positionPx: [100, 200], sizePx: [64, 64], frame: 0 });

const sr = createSpriteRenderer(engine, {
    layers: [layer],
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
});
registerSpriteRenderer(sr);

await startEngine(engine);
```

Nothing in `src/scene/*` is reachable from this code path — not even
`scene-core.ts`. Anchored sprites are unsupported here (they require a
camera).

---

## Internal Architecture

### Core Rule: No `if` Across Modes (still)

There is still no shared `createSprite()`, no `SpriteMode` enum, no per-
frame `if (sprite.kind === ...)`. The two families have separate composers,
separate renderables, separate WGSL. The unification happens at the
**scene** layer, not at the sprite-shader layer. The `AnchorSource`
projection is a CPU step on a sparse per-layer map; it writes into the
owning layer's already-fixed instance layout (40 B for pure-2D, 44 B for
depth-hosted).

### Per-Instance GPU Layout

`Sprite2DLayer` fixes its instance stride at creation from `depth`.
`depth: "none"` uses 40 bytes / 10 floats and has no Z lane. `depth:
"test" | "test-write"` uses 44 bytes / 11 floats and exposes slot [10]
as the per-instance depth attribute. Anchor data lives off-instance in a
sparse JS map. Per-layer constants (view, screen size, pivot, opacity)
live in a separate 48-byte UBO bound at `@group(0) @binding(0)` for the
pure renderer and `@group(1) @binding(0)` for the depth-hosted scene
renderable.

#### Sprite2DLayer pure per-instance vertex buffer (40 B = 10 floats)

| Offset (bytes) | Slot   | Field        | Vertex attr             | Notes                                                                      |
| -------------- | ------ | ------------ | ----------------------- | -------------------------------------------------------------------------- |
| 0..7           | [0..1] | `positionPx` | `@location(0)` f32×2    | layer-space pixels; for anchored sprites, written by the CPU sync hook     |
| 8..15          | [2..3] | `sizePx`     | `@location(1)` f32×2    | width/height in pixels; zeroed when `visible: false` (degenerate quad)     |
| 16..23         | [4..5] | `uvMin`      | `@location(2)` f32×2    | atlas UV min                                                               |
| 24..31         | [6..7] | `uvMax`      | `@location(3)` f32×2    | atlas UV max                                                               |
| 32..35         | [8]    | `rotation`   | `@location(4)` f32      | radians; vertex shader takes `sin`/`cos` once per vertex                   |
| 36..39         | [9]    | `colorRGBA`  | `@location(5)` unorm8x4 | packed via the cached `Uint32Array` view aliased on `_instanceData.buffer` |

#### Sprite2DLayer depth-hosted extension (44 B = 11 floats)

Depth-hosted layers use the same first 40 bytes, plus:

| Offset (bytes) | Slot | Field | Vertex attr        | Notes                                                             |
| -------------- | ---- | ----- | ------------------ | ----------------------------------------------------------------- |
| 40..43         | [10] | `z`   | `@location(6)` f32 | NDC depth (`0` = near, `1` = far), consumed by the scene pipeline |

Slot [9] is laid out as 4 bytes inside the homogeneous `Float32Array` backing
store; the bits are written via the cached `_instanceDataU32` view on
`layer._instanceData.buffer`. The renderer treats it as a `unorm8x4` vertex
attribute on the GPU.

Visibility (`visible: false`) is implemented by zeroing slots [2..3]; the
sprite's true size lives in `layer._savedSize` so a later `visible: true`
(without re-supplying `sizePx`) can restore it.

**Per-instance Z, not per-layer, for depth-hosted layers.** A single
depth-hosted layer can mix sprites at different depths — useful where
one sprite goes in front of a 3D object and another behind it. Pure-2D
layers do not allocate, upload, declare, or fetch a Z slot; `z` remains
accepted by the public props shape but is ignored before storage.

#### Sprite2DLayer Layer UBO (48 B = 12 floats; std140-aligned)

Bound at `@group(0) @binding(0)`. Updated each frame from current view +
target dimensions; written via `device.queue.writeBuffer` only when the
12-float scratch buffer differs from the previously-written copy.

| WGSL field   | Offset | Notes                                                                                                                                                                       |
| ------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewPos`    | 0      | `vec2<f32>` — layer view's pan in pixels                                                                                                                                    |
| `viewScale`  | 8      | `f32` — layer view's zoom                                                                                                                                                   |
| `viewRot`    | 12     | `f32` — layer view's rotation in radians                                                                                                                                    |
| `screenSize` | 16     | `vec2<f32>` — engine target size in pixels                                                                                                                                  |
| `pivot`      | 24     | `vec2<f32>` — layer-wide rotation/scaling pivot in normalised sprite-local space                                                                                            |
| `opacityMul` | 32     | `vec4<f32>` — pre-shaped per layer opacity. Straight-alpha: `(1, 1, 1, opacity)`. Premultiplied: `(o, o, o, o)`. CPU pre-shapes per blend mode so the shader is branch-free |

Total 48 bytes — `vec4<f32>` forces 16-byte struct alignment and 48 = 3 × 16 is naturally
aligned; no padding required.

#### BillboardSpriteSystem (96 B = 24 floats)

Storage-buffer-bound at `@group(1) @binding(3)` (not a vertex buffer —
3D sprite families read sprite data through a storage buffer indexed by
a sort-indirection vertex attribute, see below). The 24-float layout:

| Offset (floats) | Field         | Notes                                               |
| --------------- | ------------- | --------------------------------------------------- |
| 0..2            | `worldPos`    | xyz — anchor position in world space                |
| 3               | `_reserved`   | 0 (anchored layers use this slot for `depthBias`)   |
| 4..5            | `_reserved`   | (0,0) (anchored layers use these for `offsetPx`)    |
| 6..7            | `sizeWorld`   | width/height in world units                         |
| 8..9            | `pivot`       | normalized [0,1]                                    |
| 10..11          | `sinCos`      | precomputed sin/cos of rotation                     |
| 12..15          | `uvRect`      | uvMin.xy, uvMax.xy                                  |
| 16..19          | `color`       | RGBA tint                                           |
| 20..23          | `flagsAndPad` | float-encoded `[flipX, flipY, pickable, _reserved]` |

The lock axis (axis-locked variant only) lives in the **system UBO**, not
per-sprite. The reserved slots at floats 3..5 stay in the layout because
the same packed-buffer layout and pack helper signature is shared with
the depth-hosted Sprite2DLayer's anchored-write path (which uses those
slots for `depthBias` and `offsetPx`); for billboard-only systems the CPU
pack helper writes 0.0.

##### Sort Indirection + Storage Buffer

Billboard systems never reorder the packed sprite buffer. Sorting is
expressed entirely through a separate `Uint32Array` indirection buffer of
sprite indices, uploaded once per frame as a per-instance vertex
attribute at `@location(0)`. The shader reads `sortIndex` and indexes
into the packed sprite storage buffer to fetch the actual record. This
keeps sort cost O(N), not O(N × stride).

**Packed sprite buffer.** Allocated by `sprite-gpu.ts` with
`usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST`.

**Sort indirection vertex buffer.** Per-instance Uint32 buffer at
`@location(0)` with `stepMode: "instance"`, `arrayStride: 4`, attribute
format `uint32`. One u32 per active sprite. Recreated when storage
capacity grows.

**Storage buffer binding.** Bound at `@group(1) @binding(3)` as
`var<storage, read> sprites: array<SpriteData>`. Bind-group layout entry
uses `buffer: { type: "read-only-storage" }` with
`GPUShaderStage.VERTEX` visibility. The renderable rebuilds the layer
bind group lazily — only when `system._storage.gpuBuffer` (the JS
pointer) changes between frames (capacity grew, or first sync).

**Shared WGSL.** `sprite/shared/sprite-3d-instance-wgsl.ts` exports two
TS string consts that every billboard variant shader includes:

```wgsl
// SPRITE_3D_DATA_WGSL — 96 B / 24-float storage record.
struct SpriteData {
    worldPos: vec3<f32>,
    depthBias_or_reserved: f32,        // anchored: depthBias; billboard: 0
    offsetPx_or_reserved: vec2<f32>,   // anchored: offsetPx; billboard: (0,0)
    sizePxOrWorld: vec2<f32>,          // anchored: sizePx;   billboard: sizeWorld
    pivot: vec2<f32>,
    sinCos: vec2<f32>,
    uvRect: vec4<f32>,
    color: vec4<f32>,
    flagsAndPad: vec4<f32>,            // .x flipX, .y flipY, .z pickable, .w reserved
};
@group(1) @binding(3) var<storage, read> sprites: array<SpriteData>;

// SPRITE_3D_VS_IN_WGSL — input/output structs + helpers.
struct VSIn {
    @builtin(vertex_index) vid: u32,
    @location(0) sortIndex: u32,
};
struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
};
fn rotate2(p: vec2<f32>, sinCos: vec2<f32>) -> vec2<f32> { /* ... */ }
fn cornerOf(vid: u32) -> vec2<f32> { /* 6-corner triangle list */ }
fn cornerUV(corner: vec2<f32>, rect: vec4<f32>, flipX: f32, flipY: f32) -> vec2<f32> { /* ... */ }
```

`SpriteData` field names are deliberately unified
(`depthBias_or_reserved`, `offsetPx_or_reserved`, `sizePxOrWorld`) so a
single struct definition serves both billboard variants and the
anchored-write path inside Sprite2DLayer. Billboard shaders ignore
`depthBias_or_reserved` and read `sizePxOrWorld` as world size.

**Re-sort triggers.** A re-sort runs only when at least one of the
following changed since the last sync:

- `_sortVersion` (bumped by add / remove / position update).
- Camera world-position (only matters for blended systems — cutout
  systems do not back-to-front sort).
- Sprite count (forces re-upload after grow).

**Cutout vs. blended.** Cutout systems always emit a sequential `0..N-1`
indirection (no per-frame back-to-front cost) so the shader path stays
uniform. Blended systems use insertion sort over squared camera
distance — fast for small N and near-sorted lists, which is the typical
case as the camera moves smoothly.

**`SpriteSortState`** (lives in `sprite/shared/sprite-sort.ts`):

```typescript
export interface SpriteSortState {
    indexBuffer: GPUBuffer | null;
    indices: Uint32Array;
    distances: Float32Array;
    lastSortVersion: number;
    lastCamX: number;
    lastCamY: number;
    lastCamZ: number;
    lastUploadedCount: number;
    blended: boolean;
    centroid: [number, number, number];
}
```

**Centroid for engine-wide transparent sort.**
`computeSpriteCentroid(state, storage)` walks the first three floats of
every active slot, computes the mean world position, writes it into
`state.centroid`, and returns it. The renderable copies this into
`Renderable._worldCenter` every frame so the engine-wide transparent
sort orders billboard systems correctly against transparent meshes.

**Helpers exported by `sprite-sort.ts`:**

- `createSpriteSortState(blended)` — allocate state. GPU buffer is created lazily on first sync.
- `syncSpriteSortIndices(engine, state, storage, sortVersion, camX, camY, camZ, label)` — ensures capacity, runs sort if any trigger fired, uploads via a single `writeBuffer`.
- `computeSpriteCentroid(state, storage)` — mean world position of all active slots.
- `disposeSpriteSortState(state)` — release the GPU index buffer.

### Vertexless Quad

No vertex buffer for positions. Six invocations per instance from
`@builtin(vertex_index)` (triangle list):

```wgsl
const QUAD_CORNERS: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
    vec2<f32>(0, 0), vec2<f32>(1, 0), vec2<f32>(1, 1),
    vec2<f32>(0, 0), vec2<f32>(1, 1), vec2<f32>(0, 1),
);
```

Draw call: `pass.draw(6, batch.count)` with `topology: 'triangle-list'`.
Triangle-list (not triangle-strip) eliminates a class of corner-case
driver differences across WebGPU implementations.

### CPU → GPU Sync (`sprite-gpu.ts`)

Each layer/system owns a single `Float32Array` packed buffer sized at
`capacity × stride`. On per-frame sync:

1. If `_version === _gpuVersion`, skip.
2. Otherwise, walk `[dirtyMin, dirtyMax]` and for each dirty slot pack
   the 20- or 24-float record. Resolve `frame` to UV rect via
   `atlas.frames[frameIndex]`.
3. Single
   `device.queue.writeBuffer(_gpuBuffer, dirtyMin*stride, _data.buffer, dirtyMin*stride, (dirtyMax - dirtyMin + 1) * stride)`.
4. `_gpuVersion = _version`.

Capacity grows 2× on overflow (fresh allocation + copy). The renderable's
GPU buffer reference is rebuilt internally on grow and the new buffer is
rebound at the next frame's `draw()` — callers hold no GPU buffer
handles, so no caller action is required. Sprite indices remain stable
across grows. Removal is **swap-remove** (last slot moves into the gap;
that slot's `_dirty` is bumped). Same pattern as `mesh/thin-instance.ts`.

This module is **dynamically imported** by every family renderable, so a
2D-only scene does not bundle billboard or anchored code.

Anchor projection feeds the dirty-range mechanism via the same
`updateSprite2DIndex` write path used by every other update. Anchor
sprites whose projected position changes every frame (the common case)
are effectively a full re-upload of the anchored sprites' contiguous slot
range each frame — same cost profile as a per-frame-moving particle
layer. Static anchors (parent never moves, camera never moves) skip
upload via the `_version === _gpuVersion` short-circuit.

#### Dirty / Version Tracking

| Field          | Bumped by                                                               | Checked by         |
| -------------- | ----------------------------------------------------------------------- | ------------------ |
| `_version`     | All `add*` / `update*` / `remove*` / `set*Frame` / clip-advance helpers | GPU sync           |
| `_gpuVersion`  | GPU sync after upload                                                   | —                  |
| `_sortVersion` | Camera change (billboard families) or any 3D-position change            | Sort recomputation |

#### Visibility (`visible: false`)

Toggling `visible: false` on a sprite does **not** compact the array or
shift indices. The pack step writes `sizePx = [0, 0]` (or
`sizeWorld = [0, 0]`) into the slot; the vertex shader collapses all six
vertices to a single point and the rasterizer emits zero fragments.
Indices stay stable, sort order is unaffected, and toggling visibility is
just a regular `update*({ visible })` call that bumps `_version`.
Trade-off: invisible sprites still cost their stride bytes in the
per-frame upload range. For layers with dense visibility churn (rare in
practice), split into two layers instead.

### Hook Registration Order

Per-layer animation/clip ticks AND the per-layer anchor-projection hook
both register into `scene._beforeRender` via `unshift`, so they run
before any user `onBeforeRender` callback. **This is required by the
freeze-flag contract**: applications that drive deterministic capture
(e.g. `seekTime` reference scenes) advance N frames and then set a
freeze flag in their own `onBeforeRender`; that callback must observe
the fully-advanced clip state on the freeze frame, otherwise the layer
loses one tick of animation in the captured image. All sprite families
(Sprite2D, anchored Sprite2D, Billboard) share this convention.

---

## Pipeline Configuration

### Shared Across All Layers

| Setting       | Value                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Topology      | `triangle-list`                                                                                                                                                                    |
| Index buffer  | shared 6-index Uint16 quad index buffer (one per `SpriteRenderer` and one per depth-hosted renderable)                                                                             |
| Cull mode     | `none`                                                                                                                                                                             |
| Front face    | `ccw`                                                                                                                                                                              |
| Color target  | engine swap-chain format                                                                                                                                                           |
| MSAA          | `SpriteRenderer` always records a direct swapchain pass with `sampleCount = 1`; depth-hosted Sprite2D layers inherit the scene render target's sample count inside the frame graph |
| Atlas sampler | per-atlas (`linear` or `nearest`), `clamp-to-edge`, no mipmaps default                                                                                                             |

### Sprite2DLayer per-`depth` Pipeline State

| Layer `depth`  | Drawn via                                                                       | Depth attachment        | Depth compare | Depth write | Instance layout / Z                  | Render order                                                |
| -------------- | ------------------------------------------------------------------------------- | ----------------------- | ------------- | ----------- | ------------------------------------ | ----------------------------------------------------------- |
| `"none"`       | A `SpriteRenderer` registered on the engine                                     | none                    | none          | `false`     | 40 B / 10 floats; no slot [10]       | engine registration order; layer order within the renderer  |
| `"test"`       | `addDepthHostedSpriteLayer` → `sprite-renderable.ts` (renderable `order = 200`) | engine depth attachment | `less-equal`  | `false`     | 44 B / 11 floats; slot [10] consumed | scene transparent queue (after opaque meshes)               |
| `"test-write"` | `addDepthHostedSpriteLayer` → `sprite-renderable.ts` (renderable `order = 100`) | engine depth attachment | `less-equal`  | `true`      | 44 B / 11 floats; slot [10] consumed | direct-drawn after cached opaque meshes, before transparent |

The sprite pipeline cache key includes `(format, sampleCount, blendMode, hasDepth, depthWrite, depthStencilFormat)`. `SpriteRenderer`
layers always request `hasDepth = false` and `sampleCount = 1`, so their pipelines are built without a depth-stencil descriptor. Depth-hosted layers request `hasDepth = true`, use the target depth-stencil format provided by the frame graph, and set `depthWrite` from the layer's `depth` mode.

### Bind Group Layouts

**`Sprite2DSceneUBO`** (32 B) — `@group(0) @binding(0)` for every
`Sprite2DLayer` regardless of caller. Allocated once per
`SpriteRenderer` instance (or per `Sprite2DLayer` renderable for the
in-scene depth-hosted path) and updated each frame from the supplied
target metadata + (when a scene is present) the camera basis. Anchored
sprites do not need a `viewProjection` in the shader because anchor
projection runs CPU-side.

```wgsl
struct Sprite2DSceneUBO {
    viewportPx: vec2<f32>,
    invViewportPx: vec2<f32>,
    viewPositionPx: vec2<f32>,
    zoom: f32,
    viewRotation: f32,
};
```

**`Sprite3DSceneUBO`** — billboard-only. Allocated lazily by the first
billboard system added; lives in `sprite/billboard/sprite-3d-scene-ubo.ts`.
Pure-2D + anchored-only scenes never load it. Sprite billboard
renderables bind it at `@group(0) @binding(0)` in place of the engine's
main 3D `SceneUBO` — billboard vertex shaders only need `viewProjection`
plus the camera basis and viewport, all of which this UBO carries.

```wgsl
// Lives in its own module (sprite-3d-scene-ubo.ts). Sprite-free scenes never
// allocate this UBO and never import the module (dynamic import via the
// billboard renderable builder). The engine's main `SceneUBO` is used by
// mesh renderables only.
struct Sprite3DSceneUBO {
    viewProjection: mat4x4<f32>,   // pre-multiplied so sprite shaders avoid binding
                                   // the engine SceneUBO and stay self-contained.
    cameraRight: vec4<f32>,        // .xyz = camera right basis, .w = cameraPos.x
    cameraUp: vec4<f32>,           // .xyz = camera up basis,    .w = cameraPos.y
    cameraForward: vec4<f32>,      // .xyz = camera forward,     .w = cameraPos.z
    viewportPx: vec2<f32>,
    invViewportPx: vec2<f32>,
};
```

The `Sprite3DSceneUBO` updater is registered into
`stage.state._uniformUpdaters` exactly once, the first time any
billboard family is added to the scene. Subsequent systems reuse the
same UBO. If the user later removes the last billboard system, the
updater stays registered for the remainder of the scene's lifetime (no
per-frame `if` to check whether sprites still exist) — but the UBO and
its updater were never created in the first place for sprite-free
scenes, which is what the no-pay-if-unused rule requires.

**`SpriteLayerUBO`** (32 B) — `@group(1) @binding(2)`, bound for
Sprite2DLayer (any depth mode) and the facing/yaw billboard variants.
Holds animation-friendly per-layer scalars; not in the pipeline cache key.

```wgsl
struct SpriteLayerUBO {
    opacity: f32,
    _pad: vec3<f32>,
};
```

> **WGSL alignment.** `vec3<f32>` has 16-byte alignment, so the struct
> pads to **32 bytes** total (opacity at offset 0; `_pad` at offset 16;
> trailing pad rounds to a multiple of 16). Allocate the GPU buffer at
> 32 B — a 16 B allocation will cause the WebGPU validator to reject the
> bind group with `"buffer binding ... is too small"`.

**`AxisLockedBillboardSystemUBO`** — bound at `@group(1) @binding(2)`,
**replacing** `SpriteLayerUBO` for the axis-locked billboard variant.
The shared fragment shader reads `opacity` from `@binding(2)` regardless
of which struct sits there; the field is at the same offset in both, so
the same fragment WGSL works for every family. The composer adjusts only
the struct declaration line.

```wgsl
struct AxisLockedBillboardSystemUBO {
    opacity: f32,         // offset 0 — must match SpriteLayerUBO.opacity for the shared fragment shader
    alphaCutoff: f32,     // baked into the cutout WGSL literal at composition time; this UBO field is reserved for a future runtime-tunable cutoff
    lockAxis: vec3<f32>,
    _pad: f32,
};
```

> **Implementer note.** The shared fragment shader declares
> `@group(1) @binding(2) var<uniform> layer: SpriteLayerUBO;` for
> non-axis-locked families and
> `@group(1) @binding(2) var<uniform> layer: AxisLockedBillboardSystemUBO;`
> for the axis-locked variant. Both structs expose `.opacity` at offset
> 0, so `c.a = c.a * layer.opacity;` is identical in both shaders. The
> axis-locked vertex shader additionally reads `layer.lockAxis`.

Sprite renderables bind only `Sprite2DSceneUBO` or `Sprite3DSceneUBO` at
group 0; the engine's main `SceneUBO` is not bound on sprite draws.
Group 1 holds atlas tex/sampler, the per-layer or system UBO, and (for
billboards) the packed sprite storage buffer.

### Pipeline Cache

Per-device, lazy. Key tuple:

`(family, blendMode, depth, swapChainFormat, msaaSamples, pixelSnap, alphaCutoff*)`

- `family`: `"sprite-2d" | "billboard-facing" | "billboard-yaw" | "billboard-axis"`.
- `depth`: `"none" | "test" | "test-write"` — Sprite2D only; absent for billboards (which always use the scene's 3D depth state).
- `pixelSnap`: bool — composer rewrites the snap line.
- `alphaCutoff`: bool — present only when `blendMode === "cutout"`.
- `opacity` is **not** in the key (per-layer UBO field, animatable).
- `flipX` / `flipY` are **not** in the key (per-sprite bits in the instance layout).

---

## Shader Logic

Composers (one per family / billboard variant) emit complete WGSL strings.
Five composers total: `composeSprite2D` (covers both pure-2D and anchored
layers — the WGSL is identical), `composeFacingBillboard`,
`composeYawLockedBillboard`, `composeAxisLockedBillboard`.

### Sprite2DLayer Vertex Shader (covers pure 2D AND anchored)

```wgsl
@group(0) @binding(0) var<uniform> scene: Sprite2DSceneUBO;
@group(1) @binding(2) var<uniform> layer: SpriteLayerUBO;

@vertex fn vs(in: VSIn) -> VSOut {
    let corner = cornerOf(in.vid);
    let localPx = (corner - in.pivot) * in.sizePx;
    let rotated = rotate2(localPx, in.sinCos);
    let layerPx = in.positionPx + rotated;
    let sc = vec2<f32>(sin(scene.viewRotation), cos(scene.viewRotation));
    let viewed = rotate2(layerPx - scene.viewPositionPx, sc) * scene.zoom;
    // PIXEL_SNAP: composer emits floor(viewed + 0.5) when pixelSnap is true.
    let snapped = viewed;
    let ndc = vec2<f32>(
         snapped.x * scene.invViewportPx.x * 2.0 - 1.0,
        1.0 - snapped.y * scene.invViewportPx.y * 2.0,
    );
    // For depth: "none" layers, z is ignored. For depth: "test" / "test-write",
    // layerZ ∈ [0,1] is mapped to NDC depth ∈ [1,0]. The CPU anchor sync writes
    // the projected NDC-z (with depthBias applied) into in.layerZ for anchored sprites.
    let z = 1.0 - clamp(in.layerZ, 0.0, 1.0);
    var out: VSOut;
    out.pos = vec4<f32>(ndc, z, 1.0);
    out.uv = cornerUV(corner, in.uvRect, in.flipX > 0.5, in.flipY > 0.5);
    out.color = in.color;
    return out;
}
```

Crucially: `in.positionPx` already carries the **projected** layer-space
pixel for anchored sprites, written by the CPU sync hook before this
frame's GPU upload. The shader has no idea whether the sprite is anchored.
There is no `if (anchored)`, no per-instance world-position field, and no
wasted bytes for non-anchored sprites.

### Billboard Vertex Shaders

Three vertex shaders, three pipelines, three dynamic-import chunks. No
runtime mode branch.

#### Facing (spherical)

```wgsl
@group(0) @binding(0) var<uniform> scene: Sprite3DSceneUBO;
@group(1) @binding(2) var<uniform> layer: SpriteLayerUBO;

@vertex fn vs(in: VSIn) -> VSOut {
    let s     = sprites[in.sortIndex];
    let corner = cornerOf(in.vid);
    let local  = (corner - s.pivot) * s.sizePxOrWorld;
    let rotated = rotate2(local, s.sinCos);
    // Camera basis vectors live in the sprite-only UBO — never touched in sprite-free scenes.
    let world = s.worldPos
              + scene.cameraRight.xyz * rotated.x
              + scene.cameraUp.xyz    * rotated.y;
    var out: VSOut;
    out.pos   = scene.viewProjection * vec4<f32>(world, 1.0);
    out.uv    = cornerUV(corner, s.uvRect, s.flagsAndPad.x, s.flagsAndPad.y);
    out.color = s.color;
    return out;
}
```

#### Yaw-Locked (cylindrical, world-Y axis)

```wgsl
@group(0) @binding(0) var<uniform> scene: Sprite3DSceneUBO;
@group(1) @binding(2) var<uniform> layer: SpriteLayerUBO;

@vertex fn vs(in: VSIn) -> VSOut {
    let s      = sprites[in.sortIndex];
    let corner = cornerOf(in.vid);
    let local  = (corner - s.pivot) * s.sizePxOrWorld;
    let rotated = rotate2(local, s.sinCos);
    let camPos = vec3<f32>(scene.cameraRight.w, scene.cameraUp.w, scene.cameraForward.w);
    let toCam  = normalize(camPos - s.worldPos);
    let up     = vec3<f32>(0.0, 1.0, 0.0);
    let right  = normalize(cross(up, toCam));
    let world  = s.worldPos + right * rotated.x + up * rotated.y;
    var out: VSOut;
    out.pos    = scene.viewProjection * vec4<f32>(world, 1.0);
    out.uv     = cornerUV(corner, s.uvRect, s.flagsAndPad.x, s.flagsAndPad.y);
    out.color  = s.color;
    return out;
}
```

#### Axis-Locked (arbitrary axis)

```wgsl
@group(0) @binding(0) var<uniform> scene: Sprite3DSceneUBO;
// Axis-locked replaces SpriteLayerUBO@2 with the system UBO. Both expose `.opacity`
// at offset 0 so the shared fragment shader still binds `layer` at @binding(2).
@group(1) @binding(2) var<uniform> layer: AxisLockedBillboardSystemUBO;

@vertex fn vs(in: VSIn) -> VSOut {
    let s      = sprites[in.sortIndex];
    let corner = cornerOf(in.vid);
    let local  = (corner - s.pivot) * s.sizePxOrWorld;
    let rotated = rotate2(local, s.sinCos);
    let a      = normalize(layer.lockAxis);
    let camPos = vec3<f32>(scene.cameraRight.w, scene.cameraUp.w, scene.cameraForward.w);
    let toCam  = normalize(camPos - s.worldPos);
    // Project camera direction onto the plane perpendicular to the axis.
    let f      = normalize(toCam - a * dot(toCam, a));
    let right  = normalize(cross(a, f));
    let world  = s.worldPos + right * rotated.x + a * rotated.y;
    var out: VSOut;
    out.pos    = scene.viewProjection * vec4<f32>(world, 1.0);
    out.uv     = cornerUV(corner, s.uvRect, s.flagsAndPad.x, s.flagsAndPad.y);
    out.color  = s.color;
    return out;
}
```

### Shared Fragment Shader

The fragment shader is identical across all four families
(Sprite2DLayer, Facing, Yaw, Axis billboards) because each family's
vertex shader binds a struct at `@group(1) @binding(2)` whose first
field is `opacity: f32` at offset 0. The composer emits exactly one of
two `layer:` declarations (`SpriteLayerUBO` or
`AxisLockedBillboardSystemUBO`); the body is identical.

```wgsl
@group(1) @binding(0) var atlasTex: texture_2d<f32>;
@group(1) @binding(1) var atlasSamp: sampler;
// `layer` is declared by each family's vertex shader at @group(1) @binding(2).
// Its concrete struct type is SpriteLayerUBO for Sprite2D / Facing / Yaw,
// and AxisLockedBillboardSystemUBO for axis-locked. Both expose `.opacity`
// at offset 0, so the body below is identical in every emitted shader.

@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
    var c = textureSample(atlasTex, atlasSamp, in.uv) * in.color;
    c.a = c.a * layer.opacity;      // per-layer UBO field — animation-friendly, no pipeline impact
    // CUTOFF block (cutout variant only — composer emits
    //   `if (c.a < <ALPHA_CUTOFF>) { discard; }`
    // where <ALPHA_CUTOFF> is the layer's `alphaCutoff` baked as a WGSL float
    // literal at composition time and entered into the pipeline cache key).
    // RETURN block: composer emits `return vec4<f32>(c.rgb * c.a, c.a);` for
    // `multiply` only (its `dst-color` srcFactor does not apply alpha, so the
    // shader must do it); every other mode emits `return c;`. In particular,
    // `alpha` mode must NOT premultiply here because its blend factors are
    // `(src-alpha, 1-src-alpha)` — the alpha multiplication is performed by
    // the blend stage. Premultiplying in the shader on top would yield
    // `src.rgb * src.a^2`.
    return c;
}
```

`CUTOFF` is a baked WGSL float literal (set-once at layer creation, enters
the pipeline cache key). `opacity` is **not** baked — it is read from the
per-layer UBO so that animating opacity per frame is a 4-byte UBO write,
never a pipeline recompile. This matches how Lite handles mesh `alpha`.

---

## Sorting and Transparency

| Family / variant                      | Drawn through                                                        | Render slot                                           | Per-instance Z                              | Blend     | Depth write |
| ------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------- | --------- | ----------- |
| Sprite2DLayer `depth: "none"`         | a `SpriteRenderer` registered on the engine                          | engine `_renderingContexts` (after the scene context) | none; no Z slot                             | per-blend | off         |
| Sprite2DLayer `depth: "test"` blended | `addDepthHostedSpriteLayer` → `sprite-renderable.ts` (`order = 200`) | scene transparent queue (after opaque meshes)         | consumed; per-instance depth test, no write | per-blend | off         |
| Sprite2DLayer `depth: "test"` cutout  | `addDepthHostedSpriteLayer` → `sprite-renderable.ts` (`order = 200`) | scene transparent queue (after opaque meshes)         | consumed; per-instance depth test, no write | none      | off         |
| Sprite2DLayer `depth: "test-write"`   | `addDepthHostedSpriteLayer` → `sprite-renderable.ts` (`order = 100`) | direct draw after cached opaque meshes                | consumed; per-instance depth test + write   | per-blend | on          |
| Billboard blended                     | `addToScene` → `billboard-renderable.ts` (`order = 200`)             | scene transparent queue                               | per-sprite view-Z (sort-indirection buffer) | per-blend | off         |
| Billboard cutout                      | `addToScene` → `billboard-renderable.ts` (`order = 200`)             | scene transparent queue                               | per-sprite view-Z (sort-indirection buffer) | none      | on          |

Depth-hosted Sprite2D layers do **not** sort sprites individually — each
layer becomes one `Renderable` and the GPU's depth test resolves
overlap between sprites in the same layer (cutout) or between layers
that share the depth buffer. Within a depth-hosted layer, sprites draw in insertion
order, and the per-instance Z (slot [10]) is used as the depth-test
value. Pure-2D layers have no slot [10]. Billboards use the per-sprite sort indirection buffer described
under [BillboardSpriteSystem (96 B = 24 floats)](#billboardspritesystem-96-b--24-floats).

---

## Picking

### `pickSprite2D` — CPU contributor

`pickSprite2D(layers, xPx, yPx)` takes the caller's `Sprite2DLayer` array
(typically `spriteRenderer.layers` for HUD overlays or
`scene._renderables` filtered to the Sprite2D `Renderable`s that
`addToScene` pushed there) and walks them in
reverse insertion order. For each candidate sprite it rotates the screen
point into the sprite's pivot-aware local rectangle. Anchored sprites are
read at their already-projected `positionPx` — no extra projection at
pick time. Returns the first hit (last layer, last sprite within that
layer), or `null`. The caller chooses what to pick by passing the right
layer array; there is no global registry of sprite layers to walk.

### `PickContributor` interface

A generic per-scene contributor pattern lives in
`picking/picking-contributors.ts`:

```typescript
export interface PickContributor {
    /** Issue draw commands into the shared pick pass. Returns the next free pick ID. */
    draw(ctx: PickPassContext, nextPickId: number): number;
    /** Try to resolve a pick ID returned by the GPU. Returns the domain-specific
     *  PickingInfo if this contributor owns the ID, or null otherwise. */
    resolve(pickId: number, worldPoint: [number, number, number] | null, depth: number): PickingInfo | null;
}
```

`gpu-picker.ts` runs all mesh draws first into the 1×1 ID pass (consuming
IDs `1..M`), ends that pass, then opens a second render pass that loads
the same color/depth attachments and dispatches each registered
contributor with the next free pick ID. Each contributor returns the next
free ID after its draws; the picker accumulates and uses the result to
bound mesh-vs-contributor ID dispatch. The depth-test contract (`less`)
carries across the pass boundary because the second pass loads the
previous depth, so closest-hit semantics are preserved across mesh +
contributor draws.

### Per-system contributor (Billboard)

Each `BillboardSpriteSystem` registers exactly one contributor.
Registration is idempotent (guarded by a `_pickContributorRegistered`
flag on the system) and lives in the system's renderable build path —
the contributor module is dynamic-imported only when a billboard
renderable is actually built, so mesh-only scenes pay zero bytes for
sprite picking code.

**Per-system 80-byte pick UBO**
(`BILLBOARD_PICK_UBO_BYTES = 80`, layout matches the WGSL struct in
`billboard-pick-pipeline.ts`):

| Offset | Field           | Notes                                                            |
| ------ | --------------- | ---------------------------------------------------------------- |
| 0..15  | `cameraRight`   | `vec4<f32>` — xyz from camera world matrix; `w` packs `camPos.x` |
| 16..31 | `cameraUp`      | `vec4<f32>` — xyz; `w` packs `camPos.y`                          |
| 32..47 | `cameraForward` | `vec4<f32>` — xyz; `w` packs `camPos.z`                          |
| 48..63 | `lockAxis`      | `vec4<f32>` — axis variant only; xyz; `w` unused                 |
| 64..67 | `baseId`        | `u32` — first pick ID assigned to instance 0 in this system      |
| 68..71 | `alphaCutoff`   | `f32` — used only when cutout pipeline is selected               |
| 72..79 | `_pad`          | 8 B trailing pad                                                 |

Packing the camera position into the basis vectors' `w` channels keeps
the UBO at 80 B and avoids re-binding the main `Sprite3DSceneUBO` in the
pick pass.

**Bind groups.** `@group(0)` = scene UBO (the pick-zoomed VP — same one
mesh picking uses). `@group(1)` = `tex@0`, `samp@1`, system pick UBO at
`@2`, packed sprite storage buffer at `@3` (the same buffer used for
rendering). The bind group is rebuilt lazily — only when
`system._storage.gpuBuffer` (the JS pointer) changes between picks.

**Per-(variant, isCutout) pipeline cache** (`billboard-pick-pipeline.ts`).
Cache key is `"${variant}|${isCutout ? 1 : 0}"`. Six entries maximum
(3 variants × 2 cutout flags). Each pipeline embeds the variant's basis
math (Facing reads `cameraRight.xyz` / `cameraUp.xyz`; Yaw reconstructs
`camPos` from the basis `w` channels and computes
`cross(worldUp, toCam)`; Axis does the same with the lock axis). The
fragment shader writes the pick ID as RGB and depth as `@location(1)`
matching the mesh picker's two-color-attachment contract.

**Pick ID assignment.** Each contributor's `draw` is given `nextPickId`,
draws its sprites with consecutive IDs `[baseId, baseId + count)` (the
WGSL emits `baseId + sortIndex`), and returns `baseId + count` for the
next contributor. Contributors track their own `rangeStart` / `rangeEnd`
for resolve.

**Resolution.** When the GPU picker reads back a pick ID, it iterates
contributors in registration order; the first one whose range contains
the ID returns a `PickingInfo`. The billboard contributor smuggles a
`_spritePick: SpritePickInfo` payload onto the `PickingInfo` object;
`pickBillboardSprite()` extracts it.

**UV reconstruction at resolve time.** Given the engine's reconstructed
world hit point `worldPoint` and the camera's world matrix:

1. Look up `meta = system._meta[localIndex]` for `rotation`, `pivot`, `sizeWorld`.
2. Call `basis = system._basisFn(worldPos, camRight, camUp, camPos)` (no variant branching).
3. Project `worldPoint - worldPos` onto `basis.right` / `basis.up` to get local-plane `(localX, localY)`.
4. Inverse-rotate by `meta.rotation` (positive sin/cos rotation in the shader → negate sin here).
5. Divide by `meta.sizeWorld`, add `meta.pivot`, clamp to `[0, 1]`.

This matches the shader's `(corner - pivot) * sizeWorld` plane definition
exactly.

Each picker lives in its own file (`pick-sprite-2d.ts`,
`pick-billboard.ts`) and is imported only when the corresponding `pick*`
function is called. Apps that never pick a sprite pay zero bytes for the
picker. Mesh-only scenes additionally pay zero bytes for
`picking-contributors.ts`'s body — only the lazy `getPickContributors`
dispatch in `gpu-picker.ts` references it.

---

## State Machine / Lifecycle

### Atlas + Layer Creation

```
loadSpriteAtlas(engine, url, opts) → SpriteAtlas

createSprite2DLayer(atlas, { depth })
  └─> { atlas, depth, capacity, _data (Float32Array), _animations,
        _anchored: null,                                      // sparse map; null until first anchor
        _deferredBuild,
        _version, _gpuVersion, _entityType: "sprite-2d-layer" }

createYawLockedBillboardSystem(atlas, opts)
  └─> { ..., _entityType: "billboard-sprite-system", _deferredBuild, ... }
```

### Depth-Hosted Scene Admission

Depth-hosted sprite admission lives in the sprite module as an opt-in
`addDepthHostedSpriteLayer` helper. Scene core exposes only a generic
`addDeferredSceneRenderables` hook; `addToScene` remains sprite-agnostic.
Renderable construction and depth-mode validation stay in `sprite-renderable.ts`:

```
addDepthHostedSpriteLayer(scene, layer)
  └─> rejects depth === "none"
  └─> addDeferredSceneRenderables(scene, builder)
  └─> call statically imported buildSpriteRenderable
        └─> buildSpriteRenderable(engine, layer)
        └─> push renderable/disposable into the scene
```

Pure-2D-only apps never call `addToScene` at all — they create a
`SpriteRenderer` directly, register it on the engine, and own their
layers without any scene. HUD-on-3D apps hand their HUD layers to a
separate `SpriteRenderer` and register it on the engine after
`registerScene`; depth-hosted layers go through `addDepthHostedSpriteLayer`.

### Build (at `registerScene`)

`registerScene(engine, scene)` runs each `_deferredBuild`. The sprite deferred builder
calls the statically imported `buildSpriteRenderable`, builds the pipeline (cache-keyed),
allocates the per-layer GPU instance buffer + UBO, and creates bind groups. The
depth-hosted `Renderable` (one per Sprite2D layer added through
`addDepthHostedSpriteLayer`) is pushed into `scene._renderables` with `order = 100`
(cutout / `depth: "test-write"`) or `order = 200` (blended / `depth: "test"`) so the
scene's existing renderable loop picks it up alongside opaque and transparent meshes.

`registerScene` does **not** create or own any `SpriteRenderer`. HUD
overlays are entirely caller-managed.

### Per-Frame Render

```
startEngine(engine) per-frame:
  1. Acquire swap-chain view + create command encoder.
  2. For each context c in engine._renderingContexts (in registration order):
       a. Pre-pass updates: c._update()
            Scene context:
              - Run scene._beforeRender hooks: clip ticks; anchor projection writes positionPx.
              - Run pre-pass renderables and scene uniform updaters.
            SpriteRenderer:
              - For each dirty layer: writeBuffer dirty range; update layer UBO.
       b. Record draws: c._record()
            Scene context:
              - Execute its frame graph. The default swapchain RenderPassTask
                buckets and draws renderables sorted by `order`:
                  * meshes opaque (order 0)
                  * Sprite2D depth-hosted cutout / `"test-write"` (order 100)
                  * meshes transparent
                  * Sprite2D depth-hosted blended / `"test"` (order 200)
                  * billboards (order 200)
            SpriteRenderer:
              - Open a sprite-only sampleCount=1 pass directly on the
                per-frame swapchain view with no depth attachment.
              - For each layer in this.layers (sorted by layer.order):
                  bind pipeline + groups; drawIndexed(6, count).
  3. Submit command buffer.
```

No `if (is2D)` anywhere. The engine just walks its `_renderingContexts`
list and asks each one to update and record. A `SpriteRenderer` with
zero non-empty layers skips its pass entirely. A scene with no Sprite2D
renderables draws only meshes and billboards.

### Disposal

`disposeScene(scene)` invokes every callback in `scene._disposables`,
including the per-renderable GPU buffer / bind group / pipeline cleanups,
the per-layer anchor hook removal, and the per-target depth/MSAA
attachment releases (existing code; sprites add no new attachments).

Any HUD `SpriteRenderer` the caller registered on the engine is
separately the caller's responsibility to dispose. The recommended
pattern is to wire HUD disposal to the scene lifetime via
`onSceneDispose(scene, () => disposeSpriteRenderer(hud))` after
`registerSpriteRenderer`, so a single `disposeScene(scene)` call also
takes the HUD down.

`disposeSpriteRenderer(sr)` releases the renderer's pipeline cache (per-
device, max four entries), any per-renderer UBO, and is safe to call
without having called `unregisterSpriteRenderer` first — it does both.

---

## Handles, Identity, and Parenting

Sprites in Babylon Lite use a **two-tier API** that mirrors the
Index/Handle split common in data-oriented engines (and parallels Lite's
ThinInstance vs. Mesh split for 3D geometry).

### Two-tier API design

| Tier           | Functions                                                                                                                                                                                       | Returns                                    | Use for                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Index API**  | `addSprite2DIndex`, `updateSprite2DIndex`, `removeSprite2DIndex`, `setSprite2DFrameIndex`, `playSprite2DClipIndex`, `stopSprite2DClipIndex` (and `addBillboardSpriteIndex` etc. for billboards) | `number` (slot index)                      | Tile maps, scenery, particles, large fixed-layout HUDs. Maximum throughput, zero per-sprite GC. Indices are _not_ stable — `removeXIndex` swap-removes |
| **Handle API** | `addSprite2D`, `removeSprite2D`, `addBillboardSprite`, `removeBillboardSprite` (and the matching `update*` / `setFrame` / `playClip` helpers)                                                   | `Sprite2DHandle` / `BillboardSpriteHandle` | Player characters, enemies, UI elements that move or are parented. Observable fields, stable id, optional parenting                                    |

Mario analogy: `Index` is a scenario tile (set once, never updated, can
spawn 10 000 of them); `Handle` is Mario himself (moves every frame,
parented to a moving platform, owns animation state).

The handle modules (`sprite-2d-handle.ts`,
`billboard/sprite-billboard-handle.ts`) live in separate files so that
scenes that only use the Index API never load handle code (see
**Tree-shaking** below).

### Stable IDs (`_idToIndex` / `_indexToId`)

Each handle owns a `readonly id: number` (u32, monotonically allocated
from `layer._nextHandleId`). The layer owns two parallel structures,
lazily allocated on first handle creation:

- `_idToIndex: Map<number, number> | null` — maps `handle.id` → current slot index.
- `_indexToId: Uint32Array | null` — parallel to storage capacity; maps slot index → `handle.id` (0 = no handle for that slot, since ids start at 1).

When `removeXIndex` swap-removes the last slot into the freed slot, it
patches both maps so the moved-into slot's id resolves to its new index.
When `removeSprite2D(handle)` is called, the handle module first calls
`_removeSprite2DHandleId(layer, slot)` to drop the dying handle's id
from the map, _then_ invokes `removeSprite2DIndex` (so the swap-remove
that follows correctly re-binds the moved-in slot's id without colliding
with the dying handle's id).

**Cost:** 4 B/slot in `_indexToId` + one Map lookup per handle mutation.
Index API users skip the Map entirely — they keep raw indices and pay
nothing for handle infrastructure. Both `_idToIndex` and `_indexToId`
start as `null` and stay that way for layers that only use the Index
API; bundle stays smaller.

### Handle field tables

**`Sprite2DHandle`** (Sprite2D family):

| Field      | Slot floats it writes (per `SPRITE_2D_STRIDE = 20`)                   | Setter side-effects                                                          |
| ---------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `position` | `[off+0]` = x, `[off+1]` = y                                          | Marks worldMatrix2D dirty; if parented, walker overrides next frame          |
| `sizePx`   | `[off+2]` = w·scale.x, `[off+3]` = h·scale.y (only when un-parented)  | Marks slot dirty                                                             |
| `pivot`    | `[off+4]`, `[off+5]`                                                  | —                                                                            |
| `scale`    | (none directly — scaled into sizePx)                                  | Marks worldMatrix2D dirty; re-writes packed size                             |
| `color`    | `[off+12..15]`                                                        | —                                                                            |
| `rotation` | (via `updateSprite2DIndex` patch — sin/cos at `[off+6..7]`)           | Marks worldMatrix2D dirty                                                    |
| `frame`    | UV at `[off+8..11]`                                                   | Calls `setSprite2DFrameIndex`                                                |
| `visible`  | Toggles packed sizePx between value and 0                             | Calls `writeSizePx`                                                          |
| `pickable` | Updates `_meta[i].pickable`                                           | —                                                                            |
| `layerZ`   | `[off+16]`                                                            | Clamped to `[0, 1]`                                                          |
| `parent`   | (only `IParentable2D`; doesn't touch slot directly)                   | Adds/removes from `_parentedHandles`; installs walker on first parent        |
| `anchor`   | (none directly; CPU projection writes positionPx + layerZ each frame) | Setting `AnchorSource` adds to layer `_anchored` map; setting `null` removes |

**`BillboardSpriteHandle`** (Billboard family) is structurally similar
but uses 3D `position: ObservableVec3` and `sizeWorld: ObservableVec2`
instead of `sizePx`. Its `parent` setter takes any
`IWorldMatrixProvider` (a Mesh, TransformNode, or even another sprite
handle).

### `anchor` setter — anchored sprites are still Sprite2D handles

```typescript
export interface Sprite2DHandle {
    // ... fields above ...

    /** Optional world anchor. Setting this attaches the AnchorSource;
     *  setting null removes it. Setting it to a different AnchorSource
     *  swaps the projection target without recreating the handle. */
    anchor: AnchorSource | null;
}
```

The `anchor` setter delegates to `setSprite2DAnchor(layer, slot, src)` —
which lives in `sprite-anchor.ts`, dynamic-imported on the first anchor
assignment. Handles never used as anchored sprites pay zero bytes for
anchor code. Setting `handle.anchor = createParentAnchor(mesh)` is the
canonical way to pin a sprite to a moving 3D entity; the anchor itself
encodes the parent relationship, which keeps the handle's parenting
story uniform with 3D-tracking handles. Setting it back to `null`
removes the layer's anchor entry and (if the entry was the last)
disposes the per-frame projection hook.

### 3D parenting (Billboard handles)

`BillboardSpriteHandle` implements `IParentable` + `IWorldMatrixProvider`
— the same interfaces meshes use. Setting `handle.parent = mesh` adds
the handle to `system._parentedHandles: Set<IParentedBillboardHandle>`
and installs the per-frame walker via the function-pointer hook
`system._parentedHandlesWalker` (see **Tree-shaking** below).

Each frame, before the storage sync, the renderable invokes the walker
if present. The walker iterates `_parentedHandles`, reads each handle's
`worldMatrix` (resolved lazily through the chain via
`WorldMatrixAccessors`), and writes only the **world translation** into
slot `[off+0..2]`. Sprite rotation stays as a 2D-around-pivot rotation
in the slot; parent rotation and scale do _not_ propagate to the
sprite's quad orientation (billboards face the camera in their
renderable; allowing parent rotation to tilt them would defeat the
point of a billboard). Only translation propagates.

Un-parented handles iterate over zero work — `_parentedHandles` is
`null` until the first `handle.parent = …` call.

### 2D parenting (Sprite2D)

Sprite2D handles implement `IParentable2D` + `IWorldMatrix2DProvider`,
the 2D analogues built on `Mat3` affine matrices instead of `Mat4`. This
enables Spine-style 2D skeletal hierarchies: a parent sprite's rotation
and scale _do_ propagate to children (since Sprite2D quads are
explicitly oriented in 2D, there is no "always face camera" constraint
to violate).

Sprite2D handles add a `scale: ObservableVec2` field (default `(1, 1)`)
so the handle can express non-uniform local scale on top of `sizePx`.
The walker (`walkParentedSprite2DHandles`) decomposes each handle's
world `Mat3` into `(tx, ty)`, rotation, and `(sx, sy)`, then writes:

- `[off+0..1]` = `(tx, ty)` — world translation
- `[off+2..3]` = `(sizePx.x · sx, sizePx.y · sy)` — packed size with world scale
- `[off+4..5]` = pivot (unchanged from local)
- `[off+6..7]` = `(sin(rot), cos(rot))` — world rotation

### Tree-shaking

The handle modules and the walker modules are deliberately **separate
files** so the static import graph of each renderable stays free of
handle code:

- **Renderable files** (`sprite-2d-renderable.ts`,
  `billboard/sprite-billboard-*-renderable.ts`) statically import only
  the family file (`sprite-2d.ts` etc.) — no handle modules, no walker
  modules. They invoke the per-frame walker via the function-pointer
  hook `layer._parentedHandlesWalker?.(layer)` — `null` for Index-only
  scenes, zero call cost.
- **Handle modules** statically import their corresponding walker
  module and assign it to `layer._parentedHandlesWalker` on the first
  `handle.parent = …` call. This means walker code is loaded only when
  an app actually uses parenting — apps that use handles but never
  parent never load walker code.
- **Apps that only use the Index API** (e.g. a tile-map scene) never
  import any handle module, so `_idToIndex` / `_indexToId` /
  `_parentedHandles` / `_parentedHandlesWalker` all stay `null`. The
  handle module's bytes are tree-shaken out of the bundle entirely.

### Future physics integration

The handle's `position: ObservableVec3` (or `ObservableVec2` for
Sprite2D) is the natural integration point for a future
`@babylon-lite/physics-2d` / `physics-3d` package. A physics body would
write to `handle.position.x = …` each frame from its solver state via a
per-frame sync; the observable's write-back path picks up the change and
pushes it into the GPU buffer (or into the world matrix for parented
handles). No core changes required.

This preserves the "if you don't use it, you don't pay for it" boundary:
physics is an optional package that only sees the public Handle API and
never reaches into layer internals.

---

## Babylon.js Equivalence Map

| Babylon.js                                        | Babylon Lite                                                          | Notes                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `SpriteManager` (2D usage)                        | `Sprite2DLayer` (any scene)                                           | No separate 2D scene type                                                         |
| `SpriteManager` (3D usage, world-sized)           | `*BillboardSpriteSystem`                                              | Always world-space, perspective-correct                                           |
| `SpritePackedManager`                             | `createNamedSpriteAtlas` + family factory                             | Atlas is a separate, reusable type                                                |
| `Sprite`                                          | `*Init` interfaces + per-family helpers                               | Functional, returns index or handle                                               |
| `sprite.cellIndex` / `cellRef`                    | `setSprite*Frame(layer, idx, frame)`                                  | `frame` is `number \| string`                                                     |
| `sprite.playAnimation(from, to, loop, delay, cb)` | `playSprite*Clip(layer, idx, clipName, loop)`                         | Named clips on the atlas                                                          |
| `sprite.invertU` / `invertV`                      | `init.flipX` / `init.flipY`                                           |                                                                                   |
| `sprite.angle`                                    | `init.rotation` (radians)                                             |                                                                                   |
| `sprite.position`                                 | `init.positionPx` (pure 2D) / `AnchorSource` for world-anchored       | Anchoring is opt-in via `addAnchoredSprite2D`; same layer                         |
| `sprite.size` / `width` / `height`                | `init.sizePx` (Sprite2D) / `init.sizeWorld` (Billboard)               | Type encodes pixel-space vs. world-space                                          |
| `sprite.color`                                    | `init.color` / `update*({ color: [r,g,b,a] })`                        | Per-sprite tint                                                                   |
| `mesh.billboardMode = BILLBOARDMODE_ALL`          | `createFacingBillboardSystem`                                         | Explicit factory                                                                  |
| `mesh.billboardMode = BILLBOARDMODE_Y`            | `createYawLockedBillboardSystem`                                      | Explicit factory                                                                  |
| `mesh.billboardMode = BILLBOARDMODE_X/Z`          | `createAxisLockedBillboardSystem(atlas, [1,0,0])`                     | One factory covers all axes                                                       |
| `SpriteManager.disableDepthWrite`                 | `Sprite2DLayer.depth` (`"test"` / `"test-write"`) + `SpriteBlendMode` | Composer-baked per layer                                                          |
| `AdvancedDynamicTexture` + `Image`                | `Sprite2DLayer` overlay on a 3D `SceneContext`                        | Different scope — no GUI tree                                                     |
| `scene.pickSprite(x, y)`                          | `pickSprite2D` / `pickBillboardSprite`                                | Two pickers, one per family                                                       |
| `SpriteMap` (tile maps)                           | Out of scope                                                          | Future module                                                                     |
| `SpriteManager` `epsilon` arg                     | _no equivalent_                                                       | Atlases must have transparent border / NPOT / padded sub-rects when bleed matters |
| Quad VBO                                          | Vertexless (`vertex_index`)                                           | Eliminates the static quad buffer                                                 |

### Anchored sizing — common porting pitfalls

The CPU projection code in `sprite-anchor.ts` follows the same contract
the GPU vertex shader would have used: `clipPos.w = cz` (camera-space
depth, not 3D distance), screen-up = camera up. Anchored sprites
maintain a fixed pixel size by adding a clip-space pixel offset to the
projected anchor.

When porting "constant pixel size" code from a hand-written BJS scene
that recomputes `sprite.size` per frame, two BJS-side mistakes look
correct in isolation but disagree with Lite's exact projection:

- **Use camera-space depth `cz`, not 3D distance.** The BJS sprite shader
  uses `clipPos.w = cz` for perspective divide, so the world-per-pixel
  scale at any anchor is `(2 · cz · tan(fov/2)) / viewportHeight`.
  Computing `Vector3.Distance(anchor, camPos)` over-scales off-axis
  sprites because distance includes the lateral component the
  projection does not. Extract `cz` from the view matrix as
  `|forward · anchor + tz|` (BJS view matrix per `Matrix.LookAtLHToRef`:
  forward axis `(m[2], m[6], m[10])`, translation
  `(m[12], m[13], m[14])`).

- **Apply screen-space offsets along the camera's up axis, not world-Y.**
  A "−32 px in screen space" offset on a tilted camera is along
  screen-up (which maps to the world-up axis of the view matrix:
  `(m[1], m[5], m[9])`), not world-Y. World-Y only equals screen-up when
  the camera is not tilted.

Lite's anchored projection does the equivalent in clip space directly
(anchor projected through VP, then `offsetPx` added as
`(2 · offsetPx / viewport) · w`), so neither pitfall applies on the
Lite side — they show up only when porting or authoring a parity
reference. The same maths is now performed on the CPU each frame for
anchored Sprite2D layers; the projection helper in `sprite-anchor.ts`
implements `(2 · offsetPx / viewport) · w` exactly.

---

## Dependencies

Imports:

- `Texture2D`, `loadTexture2D` from `../texture/texture-2d.js`
- `EngineContext` from `../engine/engine.js`
- `createPipelineCache` from `../material/pipeline-cache.js`
- (only in `addDepthHostedSpriteLayer` integration code, not in pure-2D bundles) `SceneContext` from `../scene/scene-core.js`, type-only
- (only in `addDepthHostedSpriteLayer` integration code, not in pure-2D bundles) `addDeferredSceneRenderables` from `../scene/scene-core.js`
- (only in `addDepthHostedSpriteLayer` integration code, not in pure-2D bundles) `buildSpriteRenderable` from `./sprite-renderable.js`

Lazy / dynamic-imported (never on the static graph of `sprite-2d.ts`):

- `AnchorSource`, `addAnchoredSprite2D` from `../sprite/anchor/sprite-anchor.js` — pulled in only when the app uses anchored sprites.
- `Sprite3DSceneUBO` from `../sprite/billboard/sprite-3d-scene-ubo.js` — pulled in only by the first billboard system.
- `gpu-picker.ts`, `picking-contributors.ts`, `billboard-pick-contributor.ts`, `billboard-pick-pipeline.ts` — pulled in only when `pickBillboardSprite` is called.

Depended on by:

- `lab/src/lite/sceneN.ts` — sprite reference scenes (2D, mixed, anchored, billboard).
- Future Particles module — reuses `SpriteAtlas`, `SpriteClip`, vertexless-quad pattern, and packed-instance-buffer helpers.

NOT depended on:

- PBR / Standard / Background materials, ShaderComposer, Mesh, Skeleton, Morph, Shadow modules — sprites use standalone WGSL with no fragment composition.

---

## Test Specification

### Unit (vitest)

- `sprite-atlas.test.ts` — atlas loaders, frame resolution, named-frame lookup.
- `sprite-animation.test.ts` — `evaluateSpriteClip`, `advanceSpriteClip`, loop / one-shot termination, `onEnd` firing.
- `sprite-pack.test.ts` — capacity grow, swap-remove, dirty-range bounds. There is only one Sprite2D stride (80 B).
- `sprite-2d-projection.test.ts` — pixel (0,0) → top-left NDC; pan + zoom + rotation correctness.
- `sprite-anchor-projection.test.ts` — Asserts that a static `createWorldAnchor([wx,wy,wz])` on a `Sprite2DLayer { depth: "test" }` produces the exact pixel position a GPU vertex-stage projection of the same anchor would produce (golden test against the analytic clip-space maths).
- `sprite-anchor-hook.test.ts` — Verifies the per-frame projection hook is installed exactly once per layer, runs before user `onBeforeRender` callbacks, and drops to a no-op when the anchored map empties.
- `sprite-billboard-basis.test.ts` — Facing / Yaw / Axis basis math regression suite.
- `sprite-sort.test.ts` — billboard-only (Sprite2D does not participate in per-sprite sort indirection).
- `sprite-pick-2d.test.ts` — covers both overlay and depth-hosted layers. Anchored hit-test uses already-projected `positionPx`.
- `sprite-pick-billboard-uv.test.ts` — UV inverse-projection at resolve time.
- `pick-contributor-registry.test.ts` — `PickContributor` interface contract.
- `mat3.test.ts` — 2D affine matrix decomposition / composition (used by Sprite2D parenting walker).
- `sprite-handle-stable-id.test.ts` — `_idToIndex` / `_indexToId` survive swap-remove.
- `sprite-handle-observable-write.test.ts` — observable field writes propagate to packed slot.
- `sprite-handle-parent-2d.test.ts` — Spine-style 2D parenting: parent rotation/scale propagate.
- `sprite-handle-anchor.test.ts` — `handle.anchor = createWorldAnchor([…])` lazy-imports `sprite-anchor.ts` and installs the projection.
- `sprite-renderer.test.ts` — `createSpriteRenderer(engine, opts)` + `registerSpriteRenderer(sr)` + `startEngine(engine)` produces a deterministic frame with no `SceneContext` in scope; verifies `disposeSpriteRenderer` releases buffers/pipelines and that `unregisterSpriteRenderer` removes it from the engine's render list.
- `rendering-context-registration.test.ts` — `engine._renderingContexts` is appended to in registration order; the first registered context's `clearValue` is used for the frame's `loadOp: "clear"`; subsequent contexts use `loadOp: "load"` automatically.
- `sprite-depth-hosted-routing.test.ts` — `addDepthHostedSpriteLayer(scene, layer)` for a `Sprite2DLayer { depth: "test" | "test-write" }` pushes a `Renderable` (with `order = 200` for `"test"`, `order = 100` for `"test-write"`) into `scene._renderables`; for `depth: "none"`, the add helper rejects before queuing scene work and tells the caller to use `createSpriteRenderer`.

### Visualization (Playwright)

Existing scene families port across (the goldens are pixel-equivalent
because the projection math is the same):

- **Scene NN-sprites-2d** — pure `Sprite2DLayer` driven by a `SpriteRenderer` registered on the engine; no `SceneContext` exists.
- **Scene NN-sprites-overlay** — a 3D scene plus a separately-registered `SpriteRenderer` for the HUD layers; HUD disposal wired via `onSceneDispose`.
- **Scene NN-sprites-anchored** — `Sprite2DLayer { depth: "test" }` added to the scene via `addDepthHostedSpriteLayer`, with `createWorldAnchor` labels pinned to mesh anchors.
- **Scene NN-sprites-billboard-yaw** — unchanged.
- **Scene NN-sprites-billboard-facing** — unchanged.
- **Scene NN-sprites-cutout-vs-blend** — unchanged.
- **Scene NN-sprites-animated** — unchanged.
- **Scene NN-sprites-mixed** — one scene with depth-hosted anchored labels behind 3D occluders AND a HUD `SpriteRenderer` registered after the scene. Verifies that the engine's per-context loop draws them in the right order (scene context first — meshes + depth-hosted sprites in `order` queues; HUD `SpriteRenderer` second — last over everything).

### Bundle Size Ceilings

Bundle-size ratchets:

- **Pure-2D ceiling.** A pure-2D entry point that imports only `createEngine`, `loadSpriteAtlas`, `createSprite2DLayer`, `addSprite2D`, `createSpriteRenderer`, `registerSpriteRenderer`, and `startEngine` must NOT fetch any of: `scene/scene-core.js`, `sprite-anchor.js`, `sprite-3d-scene-ubo.js`, `sprite-billboard-*.js`, `camera/*`, `light/*`, `mesh/*`, `shadow/*`, `material/pbr/*`, `material/standard/*`, `picking/*`. This is the single most important ceiling — it is what justifies splitting `SpriteRenderer` into its own module separate from the scene.
- **Anchored-only-no-billboard ceiling.** A scene with depth-hosted Sprite2D layers but no billboards must NOT fetch `sprite-3d-scene-ubo.js`, billboard renderables, or the GPU picker.
- **Per-billboard-variant ceiling.** Each variant (`Facing`, `YawLocked`, `AxisLocked`) must NOT include the other two.
- **Mesh-only no-sprite ceiling.** A scene with no sprites must NOT fetch `sprite-2d.js`, `sprite-renderer.js`, or the body of `picking-contributors.js`.

---

## File Manifest

```
packages/babylon-lite/src/

  scene/
    scene-core.ts                                # Existing SceneContext + addToScene switch + startEngine + onBeforeRender + disposeScene

  sprite/
    shared/
      sprite-atlas.ts                            # SpriteAtlas, createGrid/Named/loadSpriteAtlas, internal resolveSpriteFrame
      sprite-animation.ts                        # SpriteClipState, evaluate/advanceSpriteClip
      sprite-gpu.ts                              # CPU→GPU dirty-range writeBuffer, capacity grow (dynamic-imported)
      sprite-pack-2d.ts                          # 80-byte pack helper for Sprite2DLayer
      sprite-pack-billboard.ts                   # 96-byte pack helper for billboards
      sprite-3d-instance-wgsl.ts                 # Shared SPRITE_3D_DATA_WGSL + SPRITE_3D_VS_IN_WGSL helpers (billboards only)
      sprite-billboard-handle-walk.ts            # walkParentedBillboardHandles

    sprite-2d.ts                                 # createSprite2DLayer + Index API (no anchor code; foundation only)
    sprite-2d-handle.ts                          # Sprite2DHandle + addSprite2D / removeSprite2D (Handle API)
    sprite-2d-handle-walk.ts                     # walkParentedSprite2DHandles
    sprite-renderable.ts                         # Renderable builder for Sprite2DLayer depth-hosted layers
    sprite-2d-shader.ts                         # composeSprite2D WGSL emitter (covers pure 2D AND anchored)
    sprite-renderer.ts                           # createSpriteRenderer / registerSpriteRenderer / unregisterSpriteRenderer / disposeSpriteRenderer + (sampleCount, hasDepth) pipeline cache

    anchor/
      sprite-anchor.ts                           # AnchorSource + createWorldAnchor + createParentAnchor + addAnchoredSprite2D + setSprite2DAnchor + per-frame projection hook

    billboard/
      sprite-billboard-shared.ts                 # BillboardSpriteSystem common helpers + Index API
      sprite-billboard-handle.ts                 # BillboardSpriteHandle + addBillboardSprite / removeBillboardSprite
      sprite-billboard-facing.ts                 # createFacingBillboardSystem
      sprite-billboard-facing-renderable.ts
      sprite-billboard-facing-shader.ts
      sprite-billboard-yaw.ts                    # createYawLockedBillboardSystem
      sprite-billboard-yaw-renderable.ts
      sprite-billboard-yaw-shader.ts
      sprite-billboard-axis.ts                   # createAxisLockedBillboardSystem
      sprite-billboard-axis-renderable.ts
      sprite-billboard-axis-shader.ts
      sprite-3d-scene-ubo.ts                     # Sprite3DSceneUBO + updater (lazy; first billboard allocates)

    picking/
      pick-sprite-2d.ts                          # pickSprite2D — covers both overlay and depth-hosted layers
      pick-billboard.ts                          # pickBillboardSprite — dynamic-imports gpu-picker.ts
      billboard-pick-contributor.ts              # PickContributor implementation
      billboard-pick-pipeline.ts                 # Per-(variant, isCutout) pick pipeline cache

  picking/
    picking-contributors.ts                      # Generic PickContributor interface + getOrCreatePickContributors / getPickContributors
```

### Public-API additions to `packages/babylon-lite/src/index.ts`

```typescript
// ─── Engine ──────────────────────────────────────────────────────────
export type { RenderingContext, EngineContext } from "./engine/engine.js";
// `startEngine(engine)` walks `engine._renderingContexts` in registration order.
export { startEngine } from "./engine/engine.js";

// ─── Scene ───────────────────────────────────────────────────────────
// The existing scene API is unchanged. Depth-hosted Sprite2D layers use
// `addDepthHostedSpriteLayer`; HUD overlays use `createSpriteRenderer` +
// `registerSpriteRenderer`.
// `onSceneDispose(scene, cb)` is the public hook for tying caller-owned
// resources (typically a HUD `SpriteRenderer`) to the scene's lifetime.
export { addToScene, registerScene, disposeScene, onSceneDispose } from "./scene/scene.js";

// ─── Sprites ─────────────────────────────────────────────────────────
// The engine-registerable sprite renderer — usable with OR without a SceneContext.
export { createSpriteRenderer, registerSpriteRenderer, unregisterSpriteRenderer, disposeSpriteRenderer } from "./sprite/sprite-renderer.js";
export type { SpriteRenderer, SpriteRendererOptions } from "./sprite/sprite-renderer.js";

export { loadSpriteAtlas, createGridSpriteAtlas, createNamedSpriteAtlas } from "./sprite/shared/sprite-atlas.js";
export { createSpriteClipState } from "./sprite/shared/sprite-animation.js";
export type { SpriteAtlas, SpriteFrame, SpriteClip, SpriteSampling, SpriteFrameRef, SpriteClipState } from "./sprite/shared/sprite-atlas.js";
export type { SpriteBlendMode } from "./sprite/sprite-2d.js";

export { createSprite2DLayer, addSprite2D, removeSprite2D, updateSprite2D, setSprite2DFrame, playSprite2DClip, stopSprite2DClip } from "./sprite/sprite-2d.js";
export { addSprite2DIndex, updateSprite2DIndex, removeSprite2DIndex, setSprite2DFrameIndex, playSprite2DClipIndex, stopSprite2DClipIndex } from "./sprite/sprite-2d.js";
export type { Sprite2DLayer, Sprite2DLayerOptions, Sprite2DInit, Sprite2DView, Sprite2DDepthMode } from "./sprite/sprite-2d.js";
export type { Sprite2DHandle } from "./sprite/sprite-2d-handle.js";

// Anchoring — separate import path; tree-shaken if unused.
export { createWorldAnchor, createParentAnchor, addAnchoredSprite2D, setSprite2DAnchor } from "./sprite/anchor/sprite-anchor.js";
export type { AnchorSource, AnchoredSprite2DInit } from "./sprite/anchor/sprite-anchor.js";

// Billboards.
export { createFacingBillboardSystem } from "./sprite/billboard/sprite-billboard-facing.js";
export { createYawLockedBillboardSystem } from "./sprite/billboard/sprite-billboard-yaw.js";
export { createAxisLockedBillboardSystem } from "./sprite/billboard/sprite-billboard-axis.js";
export {
    addBillboardSprite,
    updateBillboardSprite,
    removeBillboardSprite,
    setBillboardSpriteFrame,
    playBillboardSpriteClip,
    stopBillboardSpriteClip,
} from "./sprite/billboard/sprite-billboard-shared.js";
export type { BillboardSpriteSystem, BillboardSpriteSystemOptions, BillboardSpriteInit } from "./sprite/billboard/sprite-billboard-shared.js";

// Picking.
export { pickSprite2D } from "./sprite/picking/pick-sprite-2d.js";
export { pickBillboardSprite } from "./sprite/picking/pick-billboard.js";
export type { SpritePickInfo } from "./sprite/picking/pick-sprite-2d.js";
```
