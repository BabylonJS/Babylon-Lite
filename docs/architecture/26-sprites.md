# Module: Sprites

> Package path: `packages/babylon-lite/src/sprite/`

## Purpose

The sprite module provides GPU-instanced, fully tree-shakeable 2D quad rendering across three distinct families. Each family is its own factory, its own renderable builder, its own WGSL vertex shader, and its own dynamic-import chunk. There is **no shared `mode` enum and no `if (mode === ...)` branch anywhere on the render path** — the user picks a factory, and that choice fixes the code path.

The three families:

1. **Pure 2D — `Scene2DContext` + `Sprite2DLayer`.**
   Pixel coordinates, orthographic projection, no depth buffer, no 3D camera, no lights. A separate scene type with a separate render loop entry point. Zero 3D overhead.

2. **Anchored — `AnchoredSpriteLayer` in a 3D `SceneContext`.**
   World position, **fixed pixel size** regardless of camera distance. The anchor is projected through the 3D camera; the quad is then expanded in pixels and added in clip space. Used for HUD pins, labels, health bars, world-anchored markers.

3. **Billboard — `*BillboardSpriteSystem` in a 3D `SceneContext`.**
   World position **and** world-unit size, perspective foreshortening, full depth participation. Three specialized factories cover the orientation policies (`Facing`, `YawLocked`, `AxisLocked`) — each a separate code path with its own vertex shader.

A `SpriteAtlas` (UV rects per frame, optional named clips) and per-sprite frame animation are first-class and **orthogonal to family** — every family accepts an atlas and supports clip playback.

## Taxonomy — Evaluation of the Proposed Three Modes

The user proposed three modes (pure 2D, 2.5D, billboard). After analysis the taxonomy is **three families**, with **billboard split into three orientation variants**:

| User mode   | Family                                       | Variants                               | Coordinate space               | Size unit   | Depth                      |
| ----------- | -------------------------------------------- | -------------------------------------- | ------------------------------ | ----------- | -------------------------- |
| "Pure 2D"   | `Sprite2DLayer` (in `Scene2DContext`)        | 1                                      | Pixels                         | Pixels      | None (no depth attachment) |
| "2.5D"      | `AnchoredSpriteLayer` (in `SceneContext`)    | 1                                      | World (anchor) → pixels (size) | Pixels      | Read only                  |
| "Billboard" | `*BillboardSpriteSystem` (in `SceneContext`) | 3: `Facing`, `YawLocked`, `AxisLocked` | World                          | World units | Read; write configurable   |

### Why not collapse pure 2D and anchored

They share screen-space-quad geometry but diverge fundamentally:

- Pure 2D needs no view matrix, no 3D camera, no depth buffer, no MSAA-aware depth resolve.
- Anchored requires the full 3D viewProjection + viewport + clip-space-W math.

Forcing them through one path would either (a) require an `if anchored ? viewProj * pos : pos`, violating the no-`if` rule, or (b) drag the entire 3D scene UBO updater + depth attachment management into 2D-only bundles, violating the bundle-size pillar. Splitting them is mandatory.

### Why split billboard into three variants

`Facing`, `YawLocked` and `AxisLocked` differ only in how the right/up basis vectors are computed in the vertex shader, but that difference is exactly the reason the user picked one over another. A unified billboard with `axisLock?: "none" | "y" | Vec3` flag forces a per-vertex runtime branch. The three factories are explicit, with three separate WGSL composers and three separate dynamic-import chunks. They share the per-instance data layout, the fragment shader, and the GPU sync code.

(`AxisLocked` subsumes a hypothetical `XLocked`/`ZLocked` — passing `[1,0,0]` or `[0,0,1]` covers them with the same shader. We do not split into four `X/Y/Z/All` modules — `AxisLocked` plus the `Y`-fast path is sufficient.)

### Modes deliberately _not_ added

- **World-aligned non-billboard sprite.** A textured world quad with fixed orientation is a `Mesh` + alpha-blended material. No new family.
- **Tile maps.** Tile-map rendering (Babylon.js `SpriteMap`) is structurally different (tile grid, vertexless quad keyed by tile index, scrollable region). Out of scope; would be a separate module.
- **Hybrid camera-driven 2D scene.** A pannable/zoomable 2D world is achieved through `Sprite2DLayer.view` (pan + zoom + rotation) inside `Scene2DContext`. No additional family.

## Resolution: The "Pure 2D Scene" Question

**Decision: A separate scene type, `Scene2DContext`, with a separate render-loop entry point, `startEngine2D`.**

Rejected alternatives:

- **Flag on `SceneContext`** (e.g. `is2D: true`) — forces `if (scene.is2D)` branches inside `startEngine`, frame loop, depth-attachment management, transparent sort, and disposal. Violates the no-`if` rule.
- **Degenerate orthographic 3D camera** — drags the perspective camera, world-matrix propagation, depth path, and 3D scene UBO into 2D-only bundles. Violates the bundle-size pillar.
- **Single `SceneContext` with renderable that "happens to do its own ortho"** — works for hello-world, but a 2D-only app still imports the entire 3D `SceneContext` machinery (lights array, shadow generators, deferred mesh builders, transparent distance sort, MSAA depth). Bundle-size cost is not zero.

The duplication cost (`createScene2DContext`, `addToScene2D`, `startEngine2D`) is small (≈100 lines) and is the only path that satisfies both pillars simultaneously. `Scene2DContext` reuses the existing `Renderable` and `SceneUniformUpdater` contracts so sprite renderable builders are not bespoke.

```typescript
// Pure 2D — zero 3D overhead, zero perspective camera code, zero light code.
const engine = await createEngine(canvas);
const scene = createScene2DContext(engine);
const atlas = await loadSpriteAtlas(engine, "sprites.png", { gridSize: [32, 32] });
const layer = createSprite2DLayer(atlas);
addSprite2D(layer, { positionPx: [100, 200], sizePx: [64, 64], frame: 0 });
addToScene2D(scene, layer);
await startEngine2D(engine, scene);
```

```typescript
// 3D scene with overlay HUD + billboard trees + anchored labels.
const scene = createSceneContext(engine);
addToScene(scene, createDirectionalLight([0, -1, 0]));
addToScene(scene, await loadGltf(engine, "world.glb"));
addToScene(scene, createYawLockedBillboardSystem(treeAtlas)); // trees
addToScene(scene, createAnchoredSpriteLayer(labelAtlas)); // nameplates
addToScene(scene, createSprite2DLayer(hudAtlas)); // HUD overlay
await startEngine(engine, scene);
```

The third snippet — `Sprite2DLayer` inside a 3D `SceneContext` — works because the layer is a regular renderable that ignores `scene.camera` and computes its own ortho projection from the swap-chain dimensions. It renders in a final overlay pass after all 3D content. The same layer factory works in both `Scene2DContext` and `SceneContext` without an `if`: the layer is camera-agnostic by construction.

---

## Public API Surface

### Shared — Atlas, Frames, Animation

```typescript
// src/sprite/sprite-atlas.ts
import type { EngineContext } from "../engine/engine.js";
import type { Texture2D, Texture2DOptions } from "../texture/texture-2d.js";

export type SpriteSampling = "linear" | "nearest";
export type SpriteBlendMode = "alpha" | "premultiplied" | "additive" | "multiply" | "cutout";
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

export function resolveSpriteFrame(atlas: SpriteAtlas, frame: SpriteFrameRef): number;

// src/sprite/sprite-animation.ts

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

### Family 1 — Pure 2D Scene + Sprite2DLayer

```typescript
// src/scene2d/scene2d.ts
import type { EngineContext } from "../engine/engine.js";
import type { Renderable, SceneUniformUpdater } from "../render/renderable.js";

export interface Scene2DOptions {
    clearColor?: GPUColorDict;
}

export interface Scene2DContext {
    readonly engine: EngineContext;
    clearColor: GPUColorDict;
    layers: Sprite2DLayer[];
}

export function createScene2DContext(engine: EngineContext, opts?: Scene2DOptions): Scene2DContext;
export function addToScene2D(scene: Scene2DContext, layer: Sprite2DLayer): void;
export function removeFromScene2D(scene: Scene2DContext, layer: Sprite2DLayer): void;
export function startEngine2D(engine: EngineContext, scene: Scene2DContext): Promise<void>;
export function renderSprite2DFrame(engine: EngineContext, scene: Scene2DContext): Promise<void>;
export function disposeScene2D(scene: Scene2DContext): void;

// src/sprite/sprite-2d.ts

/** Per-layer pan/zoom/rotation in pixel space. */
export interface Sprite2DView {
    positionPx: [number, number];
    zoom: number;
    rotation: number;
}

export interface Sprite2DLayerOptions {
    capacity?: number; // default 64; doubles on overflow
    blendMode?: SpriteBlendMode;
    pixelSnap?: boolean;
    opacity?: number;
    visible?: boolean;
    order?: number; // intra-scene draw order, ascending
    view?: Partial<Sprite2DView>;
}

export interface Sprite2DLayer {
    readonly _entityType: "sprite-2d-layer";
    readonly atlas: SpriteAtlas;
    blendMode: SpriteBlendMode;
    pixelSnap: boolean;
    opacity: number;
    visible: boolean;
    order: number;
    view: Sprite2DView;
    count: number;
    /** @internal flat sprite storage and version tracking */
}

export interface Sprite2DInit {
    positionPx: [number, number];
    sizePx?: [number, number]; // defaults to frame source size
    frame?: SpriteFrameRef; // default 0
    rotation?: number;
    pivot?: [number, number]; // overrides frame.pivot
    color?: [number, number, number, number];
    flipX?: boolean;
    flipY?: boolean;
    layer?: number; // intra-layer z-order (lower = behind)
    visible?: boolean;
    pickable?: boolean;
    clip?: SpriteClipState | null;
}

export function createSprite2DLayer(atlas: SpriteAtlas, opts?: Sprite2DLayerOptions): Sprite2DLayer;
export function addSprite2D(layer: Sprite2DLayer, sprite: Sprite2DInit): number;
export function updateSprite2D(layer: Sprite2DLayer, index: number, patch: Partial<Sprite2DInit>): void;
export function removeSprite2D(layer: Sprite2DLayer, index: number): void;
export function setSprite2DFrame(layer: Sprite2DLayer, index: number, frame: SpriteFrameRef): void;
export function playSprite2DClip(layer: Sprite2DLayer, index: number, clip: string, loop?: boolean): void;
export function stopSprite2DClip(layer: Sprite2DLayer, index: number): void;
```

**Conventions shared by every family's `*Init`** (apply to `Sprite2DInit`, `AnchoredSpriteInit`, `BillboardSpriteInit` alike):

- **Per-sprite opacity is `color.a`.** There is no separate `opacity` field on a sprite. Final pixel alpha is `textureSampleAlpha × color.a × layer.opacity`. Callers that animate “tint” and “opacity” as logically separate values (e.g. a Lottie player) pre-multiply them on the CPU into `color`. The per-layer `opacity` UBO field stays free for whole-layer fades.
- **`visible: false` keeps the slot but emits a degenerate quad.** When a sprite is invisible, `pack` writes `sizePx = [0, 0]` (or `sizeWorld = [0, 0]`) into its slot, so the vertex shader collapses all six vertices to a single point and the GPU rasterizes nothing. The slot is not removed, indices are stable, no resort is triggered. Cost: same upload bandwidth as a visible sprite, no fragment work. For dense visibility churn, split into two layers (one always-visible, one never-visible) instead.
- **Transforms are flat world-space.** Sprites have no parent/child relationship. Hierarchy (character rigs, UI panel trees, Lottie parented layers) is the responsibility of the caller — a future skeleton, GUI, or Lottie module computes flattened world transforms and feeds them to `update*({ position, rotation, sizePx, … })`. This matches how thin-instances work in Lite.
- **`*Init.clip` is a convenience.** Passing a `SpriteClipState` to `add*` is equivalent to `add*({ …, clip: undefined })` followed by `play*Clip(layer, idx, state.clipName)`. The clip state is stored in a side `Map<index, SpriteClipState>` on the layer (sparse — only sprites with active clips have entries), not in the packed instance buffer. `setSprite*Frame` and `play*Clip` mutate this map; the per-frame render loop iterates only the map's entries.

### Family 2 — Anchored Sprite Layer (3D scene, fixed pixel size)

```typescript
// src/sprite/sprite-anchored.ts
import type { SceneContext } from "../scene/scene.js";

export interface AnchoredSpriteLayerOptions {
    capacity?: number;
    blendMode?: SpriteBlendMode;
    pixelSnap?: boolean;
    opacity?: number;
    visible?: boolean;
    order?: number;
    /** When true, anchor depth is honored (sprite hidden behind closer geometry). Default true. */
    depthTest?: boolean;
}

export interface AnchoredSpriteLayer {
    readonly _entityType: "anchored-sprite-layer";
    readonly atlas: SpriteAtlas;
    blendMode: SpriteBlendMode;
    pixelSnap: boolean;
    opacity: number;
    visible: boolean;
    order: number;
    depthTest: boolean;
    count: number;
}

export interface AnchoredSpriteInit {
    position: [number, number, number];
    sizePx?: [number, number];
    frame?: SpriteFrameRef;
    rotation?: number;
    pivot?: [number, number];
    offsetPx?: [number, number];
    depthBias?: number;
    color?: [number, number, number, number];
    flipX?: boolean;
    flipY?: boolean;
    visible?: boolean;
    pickable?: boolean;
    clip?: SpriteClipState | null;
}

export function createAnchoredSpriteLayer(atlas: SpriteAtlas, opts?: AnchoredSpriteLayerOptions): AnchoredSpriteLayer;
export function addAnchoredSprite(layer: AnchoredSpriteLayer, sprite: AnchoredSpriteInit): number;
export function updateAnchoredSprite(layer: AnchoredSpriteLayer, index: number, patch: Partial<AnchoredSpriteInit>): void;
export function removeAnchoredSprite(layer: AnchoredSpriteLayer, index: number): void;
export function setAnchoredSpriteFrame(layer: AnchoredSpriteLayer, index: number, frame: SpriteFrameRef): void;
export function playAnchoredSpriteClip(layer: AnchoredSpriteLayer, index: number, clip: string, loop?: boolean): void;
export function stopAnchoredSpriteClip(layer: AnchoredSpriteLayer, index: number): void;
```

### Family 3 — Billboard Sprite Systems (3D scene, world-unit size)

There is no public `BillboardMode` enum. The user picks a factory.

```typescript
// src/sprite/sprite-billboard-{shared,facing,yaw,axis}.ts (one file per variant + one shared)

export interface BillboardSpriteSystemOptions {
    capacity?: number;
    blendMode?: SpriteBlendMode;
    opacity?: number;
    visible?: boolean;
    order?: number;
    /** Default false for blended billboards, true for cutout. */
    depthWrite?: boolean;
    /** Cutoff threshold in [0,1]. Used only when blendMode === "cutout". Default 0.5. */
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
    sizeWorld: [number, number]; // required — world units have no sensible default
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

/** Spherical billboard: faces camera fully. */
export function createFacingBillboardSystem(atlas: SpriteAtlas, opts?: BillboardSpriteSystemOptions): BillboardSpriteSystem;

/** Cylindrical billboard: rotates only around world Y. Common for trees, NPCs. */
export function createYawLockedBillboardSystem(atlas: SpriteAtlas, opts?: BillboardSpriteSystemOptions): BillboardSpriteSystem;

/** Arbitrary axis-locked billboard: pass [1,0,0], [0,0,1], or any normalized axis. */
export function createAxisLockedBillboardSystem(atlas: SpriteAtlas, axis: [number, number, number], opts?: BillboardSpriteSystemOptions): BillboardSpriteSystem;

export function addBillboardSprite(system: BillboardSpriteSystem, sprite: BillboardSpriteInit): number;
export function updateBillboardSprite(system: BillboardSpriteSystem, index: number, patch: Partial<BillboardSpriteInit>): void;
export function removeBillboardSprite(system: BillboardSpriteSystem, index: number): void;
export function setBillboardSpriteFrame(system: BillboardSpriteSystem, index: number, frame: SpriteFrameRef): void;
export function playBillboardSpriteClip(system: BillboardSpriteSystem, index: number, clip: string, loop?: boolean): void;
export function stopBillboardSpriteClip(system: BillboardSpriteSystem, index: number): void;
```

### Picking

```typescript
// src/sprite/picking/pick-2d.ts, pick-anchored.ts, pick-billboard.ts (one file per family)
export interface SpritePickInfo {
    layerOrSystem: Sprite2DLayer | AnchoredSpriteLayer | BillboardSpriteSystem;
    spriteIndex: number;
    uv: [number, number];
    screenPx: [number, number];
    worldPosition?: [number, number, number];
}

export function pickSprite2D(scene: Scene2DContext, xPx: number, yPx: number): SpritePickInfo | null;
export function pickAnchoredSprite(scene: SceneContext, xPx: number, yPx: number): SpritePickInfo | null;
/** Uses the existing GPU ID-pass picker. Async like the standard mesh picker. */
export function pickBillboardSprite(scene: SceneContext, xPx: number, yPx: number): Promise<SpritePickInfo | null>;
```

### Scene Integration

`addToScene` is extended (3D scene) and `addToScene2D` exists for the 2D scene. Both detect entities by their `_entityType` discriminator string — there is no per-frame `if mode` branch, only a one-shot routing decision at registration time.

```typescript
// In addToScene (3D scene), one new branch in the existing entity-routing switch:
//   case "anchored-sprite-layer": ...
//   case "billboard-sprite-system": ...
//   case "sprite-2d-layer": ...     (overlay use case)
// Each routes to a family-specific deferred builder. After the routing decision,
// no further mode checks happen on the render path.
```

---

## Internal Architecture

### Core Rule: No `if` Across Modes

There is no shared `createSprite()`, no `SpriteMode` enum, and no per-frame `if (sprite.kind === ...)`. The shared atlas, animation, and packing helpers operate on already-typed concrete batches; they never branch on family.

### Per-Variant `BillboardBasisFn` closure (CPU helper)

CPU helpers that need to compute the right/up basis a billboard variant uses (currently only the GPU pick contributor's UV inverse-projection) call a per-system closure rather than branching on the variant tag. The type lives in `sprite-billboard-shared.ts`:

```typescript
export type BillboardBasisFn = (
    worldPos: readonly [number, number, number],
    camRight: readonly [number, number, number],
    camUp: readonly [number, number, number],
    camPos: readonly [number, number, number],
) => { right: [number, number, number]; up: [number, number, number] };
```

Each variant factory attaches its own closure to `system._basisFn` immediately after construction:

- `facingBasisFn` (constant) — returns `{ right: camRight, up: camUp }`.
- `yawBasisFn` (closes over world-Y up) — returns `{ right: normalize(cross([0,1,0], normalize(camPos - worldPos))), up: [0,1,0] }`.
- `makeAxisBasisFn(axis)` (closes over the normalized lock axis) — returns the projected camera-perpendicular right + the lock axis as up.

Callers invoke `system._basisFn(...)` unconditionally; they never read `system._variant`. The variant tag remains on the system for diagnostic / pipeline-cache-key purposes only, never for runtime branching.

### Plain Public Data, Flat Internal Storage

The public `*Init` interfaces are ergonomic plain objects. Internally, each layer/system stores its sprite data as **interleaved typed arrays** (`Float32Array`) following the thin-instance pattern. Public mutation helpers (`updateSprite2D`, `setBillboardSpriteFrame`, etc.) write directly into the flat storage and bump a version counter. Direct array access is not exposed; for users who want raw control, `flush*` helpers exist.

### Per-Instance GPU Layout (per family)

All families use **64-byte aligned strides**. Layouts differ slightly because the meaning of fields differs:

#### Sprite2DLayer (80 B = 20 floats)

| Offset (floats) | Field         | Notes                                                                                                                                                                                                                                                           |
| --------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0..1            | `positionPx`  | layer-space pixels                                                                                                                                                                                                                                              |
| 2..3            | `sizePx`      | width/height in pixels                                                                                                                                                                                                                                          |
| 4..5            | `pivot`       | normalized [0,1]                                                                                                                                                                                                                                                |
| 6..7            | `sinCos`      | precomputed sin/cos of rotation                                                                                                                                                                                                                                 |
| 8..11           | `uvRect`      | uvMin.xy, uvMax.xy                                                                                                                                                                                                                                              |
| 12..15          | `color`       | RGBA tint                                                                                                                                                                                                                                                       |
| 16              | `layerZ`      | ordering scalar (front-to-back inside layer)                                                                                                                                                                                                                    |
| 17..19          | `flagsAndPad` | float‑encoded flags: `[0]=flipX (0.0/1.0)`, `[1]=flipY (0.0/1.0)`, `[2]=reserved`. Stored as floats (not packed bits) so the WGSL reads `in.flipX = flagsAndPad.x > 0.5;` with no bit-twiddling. The CPU pack helper writes `1.0` for true and `0.0` for false. |

#### AnchoredSpriteLayer (96 B = 24 floats)

| Offset (floats) | Field         | Notes                                                                                         |
| --------------- | ------------- | --------------------------------------------------------------------------------------------- |
| 0..2            | `worldPos`    | world-space anchor                                                                            |
| 3               | `depthBias`   | NDC-z bias added after projection (positive = pushed toward camera)                           |
| 4..5            | `offsetPx`    | pixel offset added to the rotated quad before pixel-snap                                      |
| 6..7            | `sizePx`      | width/height in pixels                                                                        |
| 8..9            | `pivot`       | normalized [0,1]                                                                              |
| 10..11          | `sinCos`      | precomputed sin/cos of rotation                                                               |
| 12..15          | `uvRect`      | uvMin.xy, uvMax.xy                                                                            |
| 16..19          | `color`       | RGBA tint                                                                                     |
| 20..23          | `flagsAndPad` | `[0]=flipX`, `[1]=flipY`, `[2]=pickable` (1.0 if `pickable !== false`, else 0.0), `[3]=reserved` — same float-encoding convention as Sprite2DLayer. The pickable bit is read by the GPU pick fragment shader for billboard variants — non-pickable sprites are `discard`-ed so the picked silhouette matches the rendered silhouette excluding non-pickable instances. Anchored layers also pack this bit for parity even though they pick on the CPU. |

#### BillboardSpriteSystem (96 B = 24 floats)

Identical layout to AnchoredSpriteLayer, with two semantic differences:

- Floats 6..7 carry `sizeWorld` (world units) instead of `sizePx`.
- Floats 3 (`depthBias`) and 4..5 (`offsetPx`) are **reserved / unused** in the billboard vertex shaders (kept in the layout to share the pack helper signature with AnchoredSpriteLayer; the CPU pack helper writes 0.0).
- Float 22 (`flagsAndPad.z`) carries the **`pickable`** bit (1.0 if `pickable !== false`, else 0.0). Read by the GPU pick fragment shader — non-pickable sprites are `discard`-ed so the picked silhouette matches the rendered silhouette excluding non-pickable instances.

The lock axis (axis-locked variant only) lives in the **system UBO**, not per-sprite.

### Vertexless Quad

No vertex buffer for positions. Six invocations per instance from `@builtin(vertex_index)`:

```wgsl
const QUAD_CORNERS: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
    vec2<f32>(0, 0), vec2<f32>(1, 0), vec2<f32>(1, 1),
    vec2<f32>(0, 0), vec2<f32>(1, 1), vec2<f32>(0, 1),
);
```

Draw call: `pass.draw(6, batch.count)` with `topology: 'triangle-list'`. (Triangle-list, not triangle-strip — `pass.draw(4, N)` with strips works on most drivers but triangle-list eliminates a class of corner-case driver differences.)

### CPU → GPU Sync (`sprite-gpu.ts`)

Each layer/system owns a single `Float32Array` packed buffer sized at `capacity × stride`. On per-frame sync:

1. If `_version === _gpuVersion`, skip.
2. Otherwise, walk `[dirtyMin, dirtyMax]` and for each dirty slot pack the 20- or 24-float record. Resolve `frame` to UV rect via `atlas.frames[frameIndex]`.
3. Single `device.queue.writeBuffer(_gpuBuffer, dirtyMin*stride, _data.buffer, dirtyMin*stride, (dirtyMax - dirtyMin + 1) * stride)`.
4. `_gpuVersion = _version`.

Capacity grows 2× on overflow (fresh allocation + copy). The renderable's GPU buffer reference is rebuilt internally on grow and the new buffer is rebound at the next frame's `draw()` — callers hold no GPU buffer handles, so no caller action is required. Sprite indices remain stable across grows. Removal is **swap-remove** (last slot moves into the gap; that slot's `_dirty` is bumped). This is the same pattern as `mesh/thin-instance.ts`.

This module is **dynamically imported** by every family renderable, so a 2D-only scene does not bundle billboard or anchored code.

**Pay-for-use** Sprites in real apps almost always move, animate, or change values; fully-static sprites are the exception. The pay-for-use guarantees here are not "static is free" — they are stronger and apply to the realistic case:

1. **Bundle**: a scene with no sprites ships zero sprite bytes (tree-shaking + dynamic imports). Independent of any runtime behavior.
2. **GPU memory**: proportional to sprite count (`N × stride`). No global sprite manager pre-allocates anything.
3. **Per-frame CPU/GPU sync**: scales with two things — the _number_ of changed sprites (CPU pack work) and the _span_ between the lowest and highest changed indices (GPU upload bytes). They are not the same. For changes at adjacent indices, both costs are proportional to "what changed": a HUD whose 5 digits live at adjacent slots in a 1000-sprite layer walks 5 pack records and uploads ~400 B. A particle-like layer where every sprite moves every frame costs `N × stride` bytes uploaded once per frame in a single coalesced `writeBuffer`, identical to `mesh/thin-instance.ts`.
4. **Static layers**: the `_version === _gpuVersion` check makes per-frame _CPU sync_ work near-zero after frame 1 — a bonus, not the headline. The renderable's `draw()` (bind groups + `pass.draw(6, count)`) still runs every frame.

Caveat: the GPU upload uses a single contiguous `[min, max]` range, not a sparse list. If sprites at indices 5 and 9990 both change in a 10000-sprite layer, the CPU pack work is still tiny (2 records) but the upload covers the full ~9986-slot range. To keep the upload size proportional to the change count, callers should keep frequently-changing sprites at adjacent indices (which happens naturally if you `add` them together) or split into smaller layers.

### Dirty / Version Tracking

| Field          | Bumped by                                                                    | Checked by         |
| -------------- | ---------------------------------------------------------------------------- | ------------------ |
| `_version`     | All `add*`/`update*`/`remove*`/`set*Frame`/clip-advance helpers and `flush*` | GPU sync           |
| `_gpuVersion`  | GPU sync after upload                                                        | —                  |
| `_sortVersion` | Camera change (3D families) or any 3D-position change                        | Sort recomputation |

### Visibility (`visible: false`)

Toggling `visible: false` on a sprite does **not** compact the array or shift indices. The pack step writes `sizePx = [0, 0]` (or `sizeWorld = [0, 0]`) into the slot; the vertex shader collapses all six vertices to a single point and the rasterizer emits zero fragments. Indices stay stable, sort order is unaffected, and toggling visibility is just a regular `update*({ visible })` call that bumps `_version`. Trade-off: invisible sprites still cost their stride bytes in the per-frame upload range. For layers with dense visibility churn (rare in practice), split into two layers instead.

### Sort Indirection + Storage Buffer (3D families)

3D sprite families (anchored + all three billboard variants) never reorder the packed sprite buffer. Sorting is expressed entirely through a separate `Uint32Array` indirection buffer of sprite indices, uploaded once per frame as a per-instance vertex attribute at `@location(0)`. The shader reads `sortIndex` and indexes into the packed sprite storage buffer to fetch the actual record. This keeps sort cost O(N), not O(N × stride).

**Packed sprite buffer.** Allocated by `sprite-gpu.ts` with `usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST`. (Sprite2DLayer still binds it as VERTEX through the pre-existing instance-attribute path; 3D families bind it as a `var<storage, read>` storage buffer instead and never declare per-instance attributes for sprite data.)

**Sort indirection vertex buffer.** Per-instance Uint32 buffer at `@location(0)` with `stepMode: "instance"`, `arrayStride: 4`, attribute format `uint32`. One u32 per active sprite. Recreated when storage capacity grows.

**Storage buffer binding.** Bound at `@group(1) @binding(3)` as `var<storage, read> sprites: array<SpriteData>`. The bind-group layout entry uses `buffer: { type: "read-only-storage" }` with `GPUShaderStage.VERTEX` visibility. The renderable rebuilds the layer bind group lazily — only when `system._storage.gpuBuffer` (the JS pointer) changes between frames (capacity grew, or first sync after construction).

**Shared WGSL.** `sprite/shared/sprite-3d-instance-wgsl.ts` exports two TS string consts that both anchored and billboard variant shaders include:

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

Field names in `SpriteData` are deliberately unified (`depthBias_or_reserved`, `offsetPx_or_reserved`, `sizePxOrWorld`) so a single struct definition serves every 3D family. Anchored shaders read `depthBias_or_reserved` as `depthBias`; billboard shaders ignore it. Anchored reads `sizePxOrWorld` as pixel size; billboards read it as world size.

**Re-sort triggers.** A re-sort runs only when at least one of the following changed since the last sync:

- `_sortVersion` (bumped by add / remove / position update).
- Camera world-position (only matters for blended layers — cutout layers do not back-to-front sort).
- Sprite count (forces re-upload after grow).

**Cutout vs. blended.** Cutout layers always emit a sequential `0..N-1` indirection (no per-frame back-to-front cost) so the shader path stays uniform. Blended layers use insertion sort over squared camera distance — fast for small N and near-sorted lists, which is the typical case as the camera moves smoothly.

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

**Centroid for engine-wide transparent sort.** `computeSpriteCentroid(state, storage)` walks the first three floats of every active slot, computes the mean world position, writes it into `state.centroid`, and returns it. The renderable copies this into `Renderable._worldCenter` every frame so the engine-wide transparent sort orders sprite systems correctly against transparent meshes.

**Helpers exported by `sprite-sort.ts`:**

- `createSpriteSortState(blended)` — allocate state. GPU buffer is created lazily on first sync.
- `syncSpriteSortIndices(engine, state, storage, sortVersion, camX, camY, camZ, label)` — ensures capacity, runs sort if any trigger fired, uploads via a single `writeBuffer`.
- `computeSpriteCentroid(state, storage)` — mean world position of all active slots.
- `disposeSpriteSortState(state)` — release the GPU index buffer.

---

## Pipeline Configuration

### Shared Across All Families

| Setting       | Value                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| Topology      | `triangle-list`                                                                        |
| Index buffer  | none (vertexless)                                                                      |
| Cull mode     | `none`                                                                                 |
| Front face    | `ccw`                                                                                  |
| Color target  | swap-chain format                                                                      |
| MSAA          | 4 in 3D scenes, **1** in `Scene2DContext`                                              |
| Atlas sampler | configurable per-atlas (`linear` or `nearest`), `clamp-to-edge`, no mipmaps by default |

### Blend Mode Pipeline States

| Blend mode      | Color (src, dst, op)                      | Alpha (src, dst, op)                | Notes                                     |
| --------------- | ----------------------------------------- | ----------------------------------- | ----------------------------------------- |
| `alpha`         | `src-alpha`, `one-minus-src-alpha`, `add` | `one`, `one-minus-src-alpha`, `add` | Default                                   |
| `premultiplied` | `one`, `one-minus-src-alpha`, `add`       | `one`, `one-minus-src-alpha`, `add` | When atlas is premultiplied               |
| `additive`      | `one`, `one`, `add`                       | `one`, `one`, `add`                 |                                           |
| `multiply`      | `dst-color`, `one-minus-src-alpha`, `add` | `one`, `one-minus-src-alpha`, `add` |                                           |
| `cutout`        | none                                      | none                                | Fragment shader `discard` < `alphaCutoff` |

Per-batch only. Per-sprite blend mode would require splitting a layer into multiple draw calls; not supported.

### Per-Family Differences

| Setting          | Sprite2DLayer                             | AnchoredSpriteLayer                                                    | Billboard (any variant)                                                                                                                          |
| ---------------- | ----------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depth attachment | **none**                                  | yes                                                                    | yes                                                                                                                                              |
| Depth compare    | n/a                                       | `less-equal` (or `always` if `depthTest=false`)                        | `less-equal`                                                                                                                                     |
| Depth write      | n/a                                       | `false`                                                                | `false` for blended, `true` for `cutout` (or per `depthWrite`)                                                                                   |
| Bind group 0     | `Sprite2DSceneUBO` @binding(0)            | `Sprite3DSceneUBO` @binding(0) (replaces 3D `SceneUBO` for sprite renderables — consolidates viewProjection + camera basis + viewport into a single UBO) | `Sprite3DSceneUBO` @binding(0) (replaces 3D `SceneUBO` for sprite renderables — consolidates viewProjection + camera basis + viewport into a single UBO) |
| Bind group 1     | tex@0, samp@1, `SpriteLayerUBO`@2         | tex@0, samp@1, `SpriteLayerUBO`@2, packed sprite storage buffer@3      | tex@0, samp@1, **`SpriteLayerUBO`@2 (facing/yaw) _or_ `AxisLockedBillboardSystemUBO`@2 (axis-locked, replaces layer UBO)**, packed sprite storage buffer@3 |
| Sort key         | `(layer.order, sprite.layerZ, insertion)` | `(layer.order, anchor view-Z back-to-front)`                           | back-to-front view-Z when blended; front-to-back view-Z when `cutout`                                                                            |
| Render queue     | dedicated overlay pass (final)            | transparent (210 + order) for blended, opaque (110 + order) for cutout | transparent (210 + order) for blended, opaque (110 + order) for cutout                                                                           |

### Bind Group Layouts

**Sprite2D scene UBO (32 B):**

```wgsl
struct Sprite2DSceneUBO {
    viewportPx: vec2<f32>,
    invViewportPx: vec2<f32>,
    viewPositionPx: vec2<f32>,
    zoom: f32,
    viewRotation: f32,
};
```

**Sprite3D scene UBO** (separate UBO, **only allocated and bound when an Anchored or Billboard family is present in the scene**; `@internal` — not exported from the public barrel). Sprite renderables bind it at `@group(0) @binding(0)` in place of the engine's main 3D `SceneUBO` — the sprite vertex shaders only need `viewProjection` plus the camera basis and viewport, all of which this UBO already carries.

```wgsl
// Lives in its own bind-group binding, in its own module (sprite-3d-scene-ubo.ts).
// Sprite-free scenes never allocate this UBO and never import the module (dynamic
// import via the sprite renderable builder). The engine's main `SceneUBO` is used
// by mesh renderables only.
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

The `Sprite3DSceneUBO` updater is registered into `scene._uniformUpdaters` exactly once, the first time any anchored or billboard family is added to the scene. Subsequent layers/systems reuse the same UBO. If the user later removes the last sprite renderable, the updater stays registered for the remainder of the scene's lifetime (no per-frame `if` to check whether sprites still exist) — but the UBO and its updater were never created in the first place for sprite-free scenes, which is what the no-pay-if-unused rule requires.

Sprite renderables bind only `Sprite3DSceneUBO` at group 0; the engine's main `SceneUBO` is not bound on sprite draws. Group 1 holds atlas tex/sampler, the per-layer or system UBO, and the packed sprite storage buffer.

**Per-layer UBO (`SpriteLayerUBO`, 32 B)** — bound at `@group(1) @binding(2)` for Sprite2DLayer, AnchoredSpriteLayer, and the facing/yaw billboard variants. Holds animation-friendly per-layer scalars; not in the pipeline cache key.

```wgsl
struct SpriteLayerUBO {
    opacity: f32,
    _pad: vec3<f32>,
};
```

> **WGSL alignment.** `vec3<f32>` has a 16-byte alignment, so the struct is padded to **32 bytes** total (opacity at offset 0; `_pad` at offset 16; trailing pad rounds the struct up to a multiple of 16). Allocate the GPU buffer at 32 B — a 16 B allocation will cause the WebGPU validator to reject the bind group with `"buffer binding ... is too small"`.

**System UBO (axis-locked billboards only)** — bound at `@group(1) @binding(2)`, **replacing** `SpriteLayerUBO` for this variant. The shared fragment shader reads `opacity` from `@binding(2)` regardless of which struct sits there; the field is at the same offset in both, so the same fragment WGSL works for every family. The composer adjusts only the struct declaration line.

```wgsl
struct AxisLockedBillboardSystemUBO {
    opacity: f32,         // offset 0 — must match SpriteLayerUBO.opacity for the shared fragment shader
    alphaCutoff: f32,     // baked into the cutout WGSL literal at composition time; this UBO field is reserved for a future runtime-tunable cutoff
    lockAxis: vec3<f32>,
    _pad: f32,
};
```

> **Implementer note.** The shared fragment shader declares `@group(1) @binding(2) var<uniform> layer: SpriteLayerUBO;` for non-axis-locked families and `@group(1) @binding(2) var<uniform> layer: AxisLockedBillboardSystemUBO;` for the axis-locked variant. Both structs expose `.opacity` at offset 0, so `c.a = c.a * layer.opacity;` is identical in both shaders. The axis-locked vertex shader additionally reads `layer.lockAxis`.

### Pipeline Cache

Per-device, lazily initialized (no module-level `Map` allocation). Key tuple:

`(family, blendMode, depthTest, depthWrite, swapChainFormat, msaaSamples, pixelSnap, alphaCutoff*)`

`pixelSnap` enters the key because the composer bakes it as branchless WGSL (the snap line is rewritten, not selected at runtime). `alphaCutoff` enters only for `cutout` — baked as a WGSL float literal. `opacity` is **not** in the key — it lives in the per-layer UBO and can be animated per frame at zero pipeline cost, matching how mesh `alpha` works in `material/tracking/std-tracking.ts`. `flipX`/`flipY` are **not** in the key either — they are per-sprite bits packed into the instance layout's `flagsAndPad` slot (so a single layer can mix flipped and unflipped sprites), and `cornerUV` reads them at runtime.

---

## Shader Logic

Shaders are produced by per-family composer functions. There is **no master sprite shader with mode `#ifdef`s** — five separate composers (`composeSprite2D`, `composeAnchoredSprite`, `composeFacingBillboard`, `composeYawLockedBillboard`, `composeAxisLockedBillboard`), each emits its own complete WGSL string.

**Composition convention.** Sprite shaders follow the existing Lite pattern for small/medium parameterized shaders: shared WGSL snippets live as TypeScript string consts in `sprite/shared/sprite-wgsl-helpers.ts` (mirroring `shader/wgsl-helpers.ts` which provides `WGSL_SCENE_UNIFORMS_PBR`, `WGSL_DITHER`, etc. consumed by `material/pbr/background-dds-skybox.ts`). Each composer concatenates the helpers with its family-specific WGSL. No separate `.wgsl` files are needed — sprite shaders are too small and too parameterized to benefit from the `?raw` import pattern used by larger compute shaders like `loader-hdr/hdr-ibl-pipeline.ts`.

### Shared Helpers (TS string consts, concatenated by each composer)

```wgsl
fn cornerOf(vid: u32) -> vec2<f32> { return QUAD_CORNERS[vid]; }
fn rotate2(p: vec2<f32>, sinCos: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(p.x * sinCos.y - p.y * sinCos.x,
                     p.x * sinCos.x + p.y * sinCos.y);
}
fn cornerUV(corner: vec2<f32>, rect: vec4<f32>, flipX: bool, flipY: bool) -> vec2<f32> {
    var u = mix(rect.x, rect.z, corner.x);
    var v = mix(rect.y, rect.w, corner.y);
    if (flipX) { u = rect.x + rect.z - u; }
    if (flipY) { v = rect.y + rect.w - v; }
    return vec2<f32>(u, v);
}
```

(`flipX`/`flipY` are per-sprite bits unpacked from the instance layout's `flagsAndPad` slot and passed into `cornerUV`. The two-line `if`s are cheap branches on uniform-across-quad bools — modern WebGPU drivers handle them with predication, not divergence. The vertex shaders below show the calls passing `false, false` for brevity; each composer actually emits `cornerUV(corner, in.uvRect, in.flipX, in.flipY)` where `in.flipX`/`in.flipY` are the unpacked bits.)

### Family 1 — Sprite2DLayer Vertex Shader

```wgsl
@group(0) @binding(0) var<uniform> scene: Sprite2DSceneUBO;
@group(1) @binding(2) var<uniform> layer: SpriteLayerUBO;
// instance attributes from 80-byte stride. `pixelSnap` is NOT an instance attribute —
// it is a per-layer flag baked into the WGSL by the composer (see PIXEL_SNAP block).

@vertex fn vs(in: VSIn) -> VSOut {
    let corner = cornerOf(in.vid);
    let localPx = (corner - in.pivot) * in.sizePx;
    let rotated = rotate2(localPx, in.sinCos);
    let layerPx = in.positionPx + rotated;
    // Apply layer view: pan, zoom, rotation
    let viewed = rotate2(layerPx - scene.viewPositionPx, vec2<f32>(sin(scene.viewRotation), cos(scene.viewRotation))) * scene.zoom;
    // Map to NDC. Y-down convention (canvas-friendly).
    // PIXEL_SNAP block: composer emits `let snapped = floor(viewed + vec2<f32>(0.5));`
    //                  when layer.pixelSnap === true, else `let snapped = viewed;`.
    //                  pixelSnap enters the pipeline cache key.
    let snapped = viewed;  // shown in non-snap form; composer rewrites this line
    let ndc = vec2<f32>(
         snapped.x * scene.invViewportPx.x * 2.0 - 1.0,
        1.0 - snapped.y * scene.invViewportPx.y * 2.0,
    );
    // layerZ ∈ [0..1] mapped to NDC depth ∈ [1..0] (lower layer behind)
    let z = 1.0 - clamp(in.layerZ, 0.0, 1.0);
    var out: VSOut;
    out.pos = vec4<f32>(ndc, z, 1.0);
    out.uv = cornerUV(corner, in.uvRect, false, false);
    out.color = in.color;
    return out;
}
```

No view matrix. No perspective divide. ~12 multiplications per vertex.

### Family 2 — AnchoredSpriteLayer Vertex Shader

```wgsl
@group(0) @binding(0) var<uniform> scene:       Sprite3DSceneUBO;    // sprite-only consolidated UBO (viewProjection + camera basis + viewport)
@group(1) @binding(2) var<uniform> layer:       SpriteLayerUBO;      // per-layer scalars (opacity)

@vertex fn vs(in: VSIn) -> VSOut {
    // 1. Project the world anchor through the sprite-only viewProjection.
    let anchorClip = scene.viewProjection * vec4<f32>(in.worldPos, 1.0);

    // 2. Compute the rotated pixel offset.
    let corner = cornerOf(in.vid);
    let localPx = (corner - in.pivot) * in.sizePx + in.offsetPx;
    let rotated = rotate2(localPx, in.sinCos);
    // PIXEL_SNAP: composer emits `let snapped = floor(rotated + vec2<f32>(0.5));`
    //             when layer.pixelSnap === true, else `let snapped = rotated;`.
    let snapped = rotated;  // shown in non-snap form; composer rewrites this line

    // 3. Convert pixel offset to NDC offset, scaled by clip.w to survive perspective divide.
    let ndcOffset = vec2<f32>(
         snapped.x * scene.invViewportPx.x * 2.0,
        -snapped.y * scene.invViewportPx.y * 2.0,
    );

    var out: VSOut;
    out.pos = vec4<f32>(
        anchorClip.x + ndcOffset.x * anchorClip.w,
        anchorClip.y + ndcOffset.y * anchorClip.w,
        anchorClip.z + in.depthBias * anchorClip.w,
        anchorClip.w,
    );
    out.uv = cornerUV(corner, in.uvRect, false, false);
    out.color = in.color;
    return out;
}
```

The sprite's screen size is invariant to camera distance — the multiplication by `anchorClip.w` exactly cancels the perspective divide.

### Family 3 — Billboard Variants

#### Facing (spherical)

```wgsl
@group(0) @binding(0) var<uniform> scene:       Sprite3DSceneUBO;    // sprite-only consolidated UBO
@group(1) @binding(2) var<uniform> layer:       SpriteLayerUBO;      // per-layer scalars (opacity)

@vertex fn vs(in: VSIn) -> VSOut {
    let corner = cornerOf(in.vid);
    let local = (corner - in.pivot) * in.sizeWorld;
    let rotated = rotate2(local, in.sinCos);
    // Camera basis vectors live in the sprite-only UBO — never touched in sprite-free scenes.
    let world = in.worldPos
              + scene.cameraRight.xyz * rotated.x
              + scene.cameraUp.xyz    * rotated.y;
    var out: VSOut;
    out.pos = scene.viewProjection * vec4<f32>(world, 1.0);
    out.uv = cornerUV(corner, in.uvRect, false, false);
    out.color = in.color;
    return out;
}
```

#### Yaw-Locked (cylindrical, world-Y axis)

```wgsl
@group(0) @binding(0) var<uniform> scene:       Sprite3DSceneUBO;
@group(1) @binding(2) var<uniform> layer:       SpriteLayerUBO;

@vertex fn vs(in: VSIn) -> VSOut {
    let corner = cornerOf(in.vid);
    let local = (corner - in.pivot) * in.sizeWorld;
    let rotated = rotate2(local, in.sinCos);
    let camPos = vec3<f32>(scene.cameraRight.w, scene.cameraUp.w, scene.cameraForward.w);
    let toCam = normalize(camPos - in.worldPos);
    let up = vec3<f32>(0.0, 1.0, 0.0);
    let right = normalize(cross(up, toCam));
    let world = in.worldPos + right * rotated.x + up * rotated.y;
    var out: VSOut;
    out.pos = scene.viewProjection * vec4<f32>(world, 1.0);
    out.uv = cornerUV(corner, in.uvRect, false, false);
    out.color = in.color;
    return out;
}
```

#### Axis-Locked (arbitrary axis)

```wgsl
@group(0) @binding(0) var<uniform> scene:       Sprite3DSceneUBO;
// Axis-locked replaces SpriteLayerUBO@2 with the system UBO. Both expose `.opacity`
// at offset 0 so the shared fragment shader still binds `layer` at @binding(2).
@group(1) @binding(2) var<uniform> layer:       AxisLockedBillboardSystemUBO;

@vertex fn vs(in: VSIn) -> VSOut {
    let corner = cornerOf(in.vid);
    let local = (corner - in.pivot) * in.sizeWorld;
    let rotated = rotate2(local, in.sinCos);
    let a = normalize(layer.lockAxis);
    let camPos = vec3<f32>(scene.cameraRight.w, scene.cameraUp.w, scene.cameraForward.w);
    let toCam = normalize(camPos - in.worldPos);
    // Project camera direction onto the plane perpendicular to the axis.
    let f = normalize(toCam - a * dot(toCam, a));
    let right = normalize(cross(a, f));
    let world = in.worldPos + right * rotated.x + a * rotated.y;
    var out: VSOut;
    out.pos = scene.viewProjection * vec4<f32>(world, 1.0);
    out.uv = cornerUV(corner, in.uvRect, false, false);
    out.color = in.color;
    return out;
}
```

Three vertex shaders, three pipelines, three dynamic-import chunks. No runtime mode branch.

### Shared Fragment Shader

```wgsl
@group(1) @binding(0) var atlasTex: texture_2d<f32>;
@group(1) @binding(1) var atlasSamp: sampler;
// `layer` is declared by each family's vertex shader at @group(1) @binding(2).
// Its concrete struct type is SpriteLayerUBO for Sprite2D / Anchored / Facing / Yaw,
// and AxisLockedBillboardSystemUBO for the axis-locked billboard. Both expose
// `.opacity` at offset 0, so the line below is identical in every emitted shader.

@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
    var c = textureSample(atlasTex, atlasSamp, in.uv) * in.color;
    c.a = c.a * layer.opacity;      // per-layer UBO field — animation-friendly, no pipeline impact
    // CUTOFF block (cutout variant only — composer emits `if (c.a < <ALPHA_CUTOFF>) { discard; }`
    //               where <ALPHA_CUTOFF> is the layer's `alphaCutoff` baked as a WGSL float literal
    //               at composition time and entered into the pipeline cache key).
    // RETURN block: composer emits `return vec4<f32>(c.rgb * c.a, c.a);` for `multiply` only
    //               (its `dst-color` srcFactor does not apply alpha, so the shader must do it);
    //               every other mode emits `return c;`. In particular, `alpha` mode must NOT
    //               premultiply here because its blend factors are `(src-alpha, 1-src-alpha)` —
    //               the alpha multiplication is performed by the blend stage. Premultiplying in
    //               the shader on top would yield `src.rgb * src.a^2`.
    return c;
}
```

The composer emits exactly the right fragment shader for the family + blend mode. `CUTOFF` is a baked WGSL float literal (set-once at layer creation, enters the pipeline cache key). `opacity` is **not** baked — it is read from the per-layer UBO so that animating opacity per frame is a 4-byte UBO write, never a pipeline recompile. This matches how Lite handles mesh `alpha` (see `material/tracking/std-tracking.ts`).

---

## Sorting and Transparency

| Family / variant              | Queue                          | Sort key                               | Blend     | Depth write  |
| ----------------------------- | ------------------------------ | -------------------------------------- | --------- | ------------ |
| Sprite2DLayer                 | dedicated overlay pass (final) | ascending `(order, layerZ, insertion)` | per-blend | n/a          |
| AnchoredSpriteLayer (blended) | transparent (210 + order)      | back-to-front by anchor view-Z         | per-blend | off          |
| AnchoredSpriteLayer (cutout)  | opaque (110 + order)           | front-to-back by anchor view-Z         | none      | on (default) |
| Billboard (blended)           | transparent (210 + order)      | back-to-front by sprite view-Z         | per-blend | off          |
| Billboard (cutout)            | opaque (110 + order)           | front-to-back by sprite view-Z         | none      | on           |

3D families share the existing engine-wide transparent sort by writing their per-frame `computeSpriteCentroid` result into `Renderable._worldCenter`. Sorting _within_ a layer/system is driven by the sort indirection + storage buffer mechanism described in [Sort Indirection + Storage Buffer (3D families)](#sort-indirection--storage-buffer-3d-families): the packed sprite buffer is never reordered, only the per-instance `Uint32` indirection at `@location(0)` changes per frame, so sort cost stays O(N) and is independent of instance stride.

**Inter-renderable interleaving:** A single sprite layer is one draw call. Individual sprites cannot interleave with arbitrary transparent meshes. This matches Babylon.js behavior. When per-sprite ordering against meshes is needed, the mitigations are (a) splitting into multiple layers with distinct `order` values, or (b) future order-independent transparency (OIT) work being developed for the 3D path; sprites will participate naturally once OIT lands because they register through the same transparent renderable interface meshes use.

**Pure 2D scene rendering:** A single render pass with no depth attachment. All visible layers are drawn in `order` ascending; sprites within a layer are drawn in `(layerZ, insertion)` ascending.

**Render-queue priorities (110 / 210):** these match the engine-wide priority scheme established by the existing 3D pipeline — opaque renderables register at priority 100–199, transparent at 200–299, with `+ order` providing intra-bucket fan-out. Sprite layers reuse the same queue API meshes use; no new queue infrastructure is introduced.

---

## Picking

All three pickers honor the per-sprite `pickable` flag (default `true`). CPU pickers (Sprite2D / Anchored) skip non-pickable sprites by checking `meta.pickable` before the rectangle test; the GPU picker (Billboard) `discard`s them in the pick fragment shader by reading `flagsAndPad.z < 0.5`. `visible: false` sprites are also skipped — the degenerate quad already returns no fragment in the GPU ID pass; CPU pickers explicitly check the visible flag before the rectangle test.

| Family              | Strategy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sprite2DLayer       | **CPU.** Walk layers in reverse `order`, then walk sprites in reverse `(layerZ, insertion)` skipping `!visible` and `!pickable`, transform the screen point into sprite-local space (inverse pan/zoom/rotation, then inverse sprite rotation around pivot), and test against the pivot-aware local rectangle `[-pivot.x · sizePx.x, (1 - pivot.x) · sizePx.x] × [-pivot.y · sizePx.y, (1 - pivot.y) · sizePx.y]` (the same `(corner - pivot) * sizePx` convention used in the WGSL).                                                                                |
| AnchoredSpriteLayer | **CPU.** For each `visible` and `pickable` sprite, project anchor through `viewProjection`, NDC → pixels, apply `offsetPx`, then transform the screen point into sprite-local space (inverse rotation around the projected pivot) and test against the same pivot-aware rectangle as Sprite2D. Walk reverse-order.                                                                                                                                                                                                                                                  |
| BillboardSpriteSystem | **GPU**, via the engine's shared `pickAsync()` 1×1 ID pass plus a per-system `PickContributor`. The pick pipeline reuses each variant's vertex math (Facing / Yaw / Axis), so the picked silhouette is byte-equal to the rendered silhouette. Cutout pipelines `discard` based on `alphaCutoff`; non-pickable sprites `discard` via `flagsAndPad.z < 0.5`. UV is reconstructed at resolve time by inverse-projecting the GPU's reconstructed world hit point through `system._basisFn` and `meta.rotation`/`meta.pivot`/`meta.sizeWorld`.                          |

### `PickContributor` interface

A generic per-scene contributor pattern lives in `picking/picking-contributors.ts`:

```typescript
export interface PickContributor {
    /** Issue draw commands into the shared pick pass. Returns the next free pick ID. */
    draw(ctx: PickPassContext, nextPickId: number): number;
    /** Try to resolve a pick ID returned by the GPU. Returns the domain-specific
     *  PickingInfo if this contributor owns the ID, or null otherwise. */
    resolve(pickId: number, worldPoint: [number, number, number] | null, depth: number): PickingInfo | null;
}
```

`gpu-picker.ts` runs all mesh draws first into the 1×1 ID pass (consuming IDs `1..M`), ends that pass, then opens a second render pass that loads the same color/depth attachments and dispatches each registered contributor with the next free pick ID. Each contributor returns the next free ID after its draws; the picker accumulates and uses the result to bound mesh-vs-contributor ID dispatch. The depth-test contract (`less`) carries across the pass boundary because the second pass loads the previous depth, so closest-hit semantics are preserved across mesh + contributor draws.

### Per-system contributor (Billboard)

Each `BillboardSpriteSystem` registers exactly one contributor. Registration is idempotent (guarded by a `_pickContributorRegistered` flag on the system) and lives in the system's renderable build path — the contributor module is dynamic-imported only when a billboard renderable is actually built, so mesh-only scenes pay zero bytes for sprite picking code.

**Per-system 80-byte pick UBO** (`BILLBOARD_PICK_UBO_BYTES = 80`, layout matches the WGSL struct in `billboard-pick-pipeline.ts`):

| Offset | Field           | Notes                                                                 |
| ------ | --------------- | --------------------------------------------------------------------- |
| 0..15  | `cameraRight`   | `vec4<f32>` — xyz from camera world matrix; `w` packs `camPos.x`     |
| 16..31 | `cameraUp`      | `vec4<f32>` — xyz; `w` packs `camPos.y`                                |
| 32..47 | `cameraForward` | `vec4<f32>` — xyz; `w` packs `camPos.z`                                |
| 48..63 | `lockAxis`      | `vec4<f32>` — axis variant only; xyz; `w` unused                       |
| 64..67 | `baseId`        | `u32` — first pick ID assigned to instance 0 in this system           |
| 68..71 | `alphaCutoff`   | `f32` — used only when cutout pipeline is selected                    |
| 72..79 | `_pad`          | 8 B trailing pad                                                      |

Packing the camera position into the basis vectors' `w` channels keeps the UBO at 80 B and avoids re-binding the main `Sprite3DSceneUBO` in the pick pass.

**Bind groups.** `@group(0)` = scene UBO (the pick-zoomed VP — same one mesh picking uses). `@group(1)` = `tex@0`, `samp@1`, system pick UBO at `@2`, packed sprite storage buffer at `@3` (the same buffer used for rendering). The bind group is rebuilt lazily — only when `system._storage.gpuBuffer` (the JS pointer) changes between picks.

**Per-(variant, isCutout) pipeline cache** (`billboard-pick-pipeline.ts`). Cache key is `"${variant}|${isCutout ? 1 : 0}"`. Six entries maximum (3 variants × 2 cutout flags). Each pipeline embeds the variant's basis math (Facing reads `cameraRight.xyz` / `cameraUp.xyz`; Yaw reconstructs `camPos` from the basis `w` channels and computes `cross(worldUp, toCam)`; Axis does the same with the lock axis). The fragment shader writes the pick ID as RGB and depth as `@location(1)` matching the mesh picker's two-color-attachment contract.

**Pick ID assignment.** Each contributor's `draw` is given `nextPickId`, draws its sprites with consecutive IDs `[baseId, baseId + count)` (the WGSL emits `baseId + sortIndex`), and returns `baseId + count` for the next contributor. Contributors track their own `rangeStart` / `rangeEnd` for resolve.

**Resolution.** When the GPU picker reads back a pick ID, it iterates contributors in registration order; the first one whose range contains the ID returns a `PickingInfo`. The billboard contributor smuggles a `_spritePick: SpritePickInfo` payload onto the `PickingInfo` object; `pickBillboardSprite()` extracts it.

**UV reconstruction at resolve time.** Given the engine's reconstructed world hit point `worldPoint` and the camera's world matrix:

1. Look up `meta = system._meta[localIndex]` for `rotation`, `pivot`, `sizeWorld`.
2. Call `basis = system._basisFn(worldPos, camRight, camUp, camPos)` (no variant branching).
3. Project `worldPoint - worldPos` onto `basis.right` / `basis.up` to get local-plane `(localX, localY)`.
4. Inverse-rotate by `meta.rotation` (positive sin/cos rotation in the shader → negate sin here).
5. Divide by `meta.sizeWorld`, add `meta.pivot`, clamp to `[0, 1]`.

This matches the shader's `(corner - pivot) * sizeWorld` plane definition exactly.

Each picker lives in its own file (`pick-2d.ts`, `pick-anchored.ts`, `pick-billboard.ts`) and is imported only when the corresponding `pick*` function is called. Apps that never pick a sprite pay zero bytes for the picker. Mesh-only scenes additionally pay zero bytes for `picking-contributors.ts`'s body — only the lazy `getPickContributors` dispatch in `gpu-picker.ts` references it.

---

## State Machine / Lifecycle

### Atlas + Layer Creation

```
loadSpriteAtlas(engine, url, opts)
  └─> SpriteAtlas (image upload + frame UV resolution + clip name lookup)

createSprite2DLayer(atlas, opts)             // or createAnchoredSpriteLayer / createFacingBillboardSystem / etc.
  └─> { atlas, capacity, _data (Float32Array), _animations, _version, _sortVersion, _gpuVersion, _entityType, _deferredBuild }
```

A `SpriteAtlas` is a shared resource: the same atlas may back multiple layers/systems across one or many scenes. Its `Texture2D` is uploaded once at `loadSpriteAtlas`. Layers hold a reference; the atlas is released only when no layer holds it (regular `Texture2D` lifetime).

### Population

```
const i = addSprite2D(layer, init)   // returns the slot index; fills next free slot in _data, bumps _version (and _sortVersion for 3D blended families)
playSprite2DClip(layer, i, name)     // attaches a SpriteClipState keyed by index
```

The returned index is the sprite's stable handle: every mutator (`setSpriteFrame`, `setSpritePosition`, `playSprite2DClip`, `removeSprite`) takes it. There is no per-sprite object — the index addresses a slot in the layer's packed `_data` array.

### Scene Registration

```
addToScene2D(scene2d, layer)   // pushes into scene.layers; queues layer._deferredBuild
addToScene(scene, billboardSystem)  // routes by _entityType to family-specific deferred builder
```

### Build (at `startEngine` / `startEngine2D`)

```
_deferredBuild(scene):
  ├─> dynamic import('./sprite-<family>-renderable.js')
  ├─> create pipeline (cache lookup by family/blend/format/msaa/pixelSnap/cutoff*)
  ├─> create scene UBO bind group (group 0)
  ├─> create group 1: tex@0, sampler@1, layer-or-system UBO@2, Sprite3DSceneUBO@3 (3D families only)
  ├─> allocate instance GPU buffer (capacity × stride, VERTEX | COPY_DST)
  └─> push Renderable + SceneUniformUpdater into scene
```

### Per-Frame Render

```
1. _beforeRender hooks: advanceSpriteClip(atlas, state, dt) for each playing clip,
   writes frameIndex via setSpriteFrame which bumps _version.
2. SceneUniformUpdater.update(): write VP matrix, camera basis vectors, viewport into scene UBO.
3. Per family/system/layer:
   a. If 3D + blended: recompute sort indices (back-to-front view-Z) when _sortVersion changed.
   b. If _version > _gpuVersion: pack dirty range into _data and writeBuffer.
   c. Bind pipeline + bind groups + instance buffer + draw-order buffer.
   d. pass.draw(6, count).
```

**Hook registration order — clip ticks must run BEFORE user callbacks.** Each
family registers its per-frame clip ticker into `scene._beforeRender` via
`unshift` (not `push`), so it executes _before_ any `onBeforeRender` callback
the application has registered. This is required by the freeze-flag contract:
applications that drive deterministic capture (e.g. `seekTime` reference
scenes) advance N frames and then set a freeze flag in their own
`onBeforeRender`; that callback must observe the fully-advanced clip state
on the freeze frame, otherwise the layer loses one tick of animation in the
captured image. All sprite families (Sprite2D, Anchored, Billboard) share
this convention.

Two independent version counters drive the two independent costs:

- `_version` — bumped by _any_ data change (frame index, position, color, opacity, size, …). Drives the dirty-range upload in step 3.b.
- `_sortVersion` — bumped _only_ when sprite Z-order can change (add, remove, position change for 3D blended families). Drives the back-to-front re-sort in step 3.a. Cutout/opaque sprites never bump it; pure-2D layers use insertion order and never sort.

### Disposal

`disposeScene2D` / `removeFromScene` releases the layer's GPU buffers via the scene's existing per-renderable `dispose` callback (the same hook meshes use to release thin-instance buffers — no new disposal infrastructure is introduced). Atlas textures follow regular `Texture2D` lifetime — they may be shared across scenes/layers and are released only when no layer holds them.

---

## Babylon.js Equivalence Map

| Babylon.js                                        | Babylon Lite                                                  | Notes                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `SpriteManager` (2D usage)                        | `Sprite2DLayer` (in `Scene2DContext`)                         | Lite carves out 2D as a first-class scene type                                            |
| `SpriteManager` (3D usage)                        | `*BillboardSpriteSystem`                                      | Always world-space, perspective-correct                                                   |
| `SpritePackedManager`                             | `createNamedSpriteAtlas` + family factory                     | Atlas is a separate, reusable type                                                        |
| `Sprite`                                          | `*Init` interfaces + per-family helpers                       | Functional, returns index                                                                 |
| `sprite.cellIndex` / `cellRef`                    | `setSprite*Frame(layer, idx, frame)`                          | `frame` is `number \| string` (named-frame lookup via atlas)                              |
| `sprite.playAnimation(from, to, loop, delay, cb)` | `playSprite*Clip(layer, idx, clipName, loop)`                 | Named clips defined on the atlas                                                          |
| `sprite.invertU` / `invertV`                      | `init.flipX` / `init.flipY`                                   |                                                                                           |
| `sprite.angle`                                    | `init.rotation`                                               | Both radians                                                                              |
| `sprite.position`                                 | `init.positionPx` (2D) / `init.position` (3D)                 |                                                                                           |
| `sprite.size` / `sprite.width` / `sprite.height`  | `init.sizePx` (2D/anchored) / `init.sizeWorld` (billboard)    | Type encodes pixel-space vs. world-space                                                  |
| `sprite.color`                                    | `init.color` / `update*({ color: [r,g,b,a] })`                | Per-sprite tint, packed in instance attributes; mutated via the family's `update*` helper |
| `mesh.billboardMode = BILLBOARDMODE_ALL`          | `createFacingBillboardSystem`                                 | Explicit factory                                                                          |
| `mesh.billboardMode = BILLBOARDMODE_Y`            | `createYawLockedBillboardSystem`                              | Explicit factory                                                                          |
| `mesh.billboardMode = BILLBOARDMODE_X/Z`          | `createAxisLockedBillboardSystem(atlas, [1,0,0])`             | One factory covers all axes                                                               |
| `SpriteManager.disableDepthWrite`                 | Implied by `SpriteBlendMode`                                  | `cutout`/`opaque` write depth; `blend` does not — no separate flag                        |
| `AdvancedDynamicTexture` + `Image`                | `Sprite2DLayer` overlay on a 3D `SceneContext`                | Different scope — no GUI tree; for retained-mode UI use a future GUI module               |
| `scene.pickSprite(x, y)`                          | `pickSprite2D` / `pickAnchoredSprite` / `pickBillboardSprite` | Three pickers, one per family                                                             |
| `SpriteMap` (tile maps)                           | Out of scope                                                  | Separate future module                                                                    |
| `SpriteManager` `epsilon` arg                     | _no equivalent_                                               | BJS insets each quad corner by `epsilon` × size (default 0.01) for atlas-bleed defense. Lite never insets — atlases are expected to have a 1-px transparent border, NPOT cells, or padded sub-rects when bleed is a concern. Porting a BJS scene 1:1 typically requires `epsilon=0` on the BJS side to match Lite's geometry. |
| Quad VBO                                          | Vertexless (`vertex_index`)                                   | Eliminates the static quad buffer                                                         |

### Anchored sizing — common porting pitfalls

Anchored sprites maintain a fixed pixel size by adding a clip-space pixel offset
to the projected anchor. When porting "constant pixel size" code from a
hand-written BJS scene that recomputes `sprite.size` per frame, two BJS-side
mistakes look correct in isolation but disagree with Lite's exact projection:

- **Use camera-space depth `cz`, not 3D distance.** The BJS sprite shader uses
  `clipPos.w = cz` for perspective divide, so the world-per-pixel scale at any
  anchor is `(2 · cz · tan(fov/2)) / viewportHeight`. Computing
  `Vector3.Distance(anchor, camPos)` over-scales off-axis sprites because
  distance includes the lateral component the projection does not. Extract `cz`
  from the view matrix as `|forward · anchor + tz|` (BJS view matrix per
  `Matrix.LookAtLHToRef`: forward axis `(m[2], m[6], m[10])`, translation
  `(m[12], m[13], m[14])`).
- **Apply screen-space offsets along the camera's up axis, not world-Y.** A
  "−32 px in screen space" offset on a tilted camera is along screen-up (which
  maps to the world-up axis of the view matrix: `(m[1], m[5], m[9])`), not
  world-Y. World-Y only equals screen-up when the camera is not tilted.

Lite's anchored layer does the equivalent in clip space directly (anchor
projected through VP, then `offsetPx` added as `(2 · offsetPx / viewport) · w`),
so neither pitfall applies on the Lite side — they show up only when porting or
authoring a parity reference.

---

## Dependencies

Imports:

- `Texture2D`, `loadTexture2D` from `../texture/texture-2d.js`
- `EngineContext` from `../engine/engine.js`
- `Scene2DContext`, `addToScene2D` from `../scene2d/scene2d.js` (Sprite2DLayer only)
- `SceneContext`, `addToScene` from `../scene/scene.js` (anchored + billboard families only)
- `Renderable`, `SceneUniformUpdater` from `../render/renderable.js` (type-only)
- `Camera` from `../camera/camera.js` (3D families: VP matrix, camera basis)
- `createPipelineCache` from `../material/pipeline-cache.js`
- `PickContributor` from `../picking/picking-contributors.js` — the billboard renderable lazily registers a per-system contributor via dynamic import of `sprite/picking/billboard-pick-contributor.js` when the system is added to the scene. The picker itself (`gpu-picker.ts`) is dynamic-imported by `pickBillboardSprite()` in `sprite/picking/pick-billboard.ts`. Mesh-only scenes pay zero bytes for sprite picking; sprite scenes that never call `pickBillboardSprite()` pay zero bytes for the picker itself.

**Dynamic-import boundary**: each family's renderable file (`sprite-2d-renderable.ts`, `sprite-anchored-renderable.ts`, `sprite-*-billboard-renderable.ts`) is loaded via dynamic `import()` from the layer/system's deferred builder — never statically. This is what makes the bundle splitting real: a scene that only uses one family ships only that family's renderable + composer + pipeline.

Depended on by:

- `lab/src/lite/sceneN.ts` — sprite reference scenes
- Future Particles module — reuses `SpriteAtlas`, `SpriteClip`, vertexless-quad pattern, and packed-instance-buffer helpers (but NOT renderables — particles are GPU-simulated)

NOT depended on:

- PBR / Standard / Background materials, ShaderComposer, Mesh, Skeleton, Morph, Shadow modules — sprites use standalone WGSL with no fragment composition

---

## Test Specification

### Unit (vitest)

- `sprite-atlas`: grid atlas UV math; named atlas frame lookup; clip name lookup.
- `sprite-animation`: clip evaluation at boundary times; loop wrap; non-loop hold + `onEnd`.
- `sprite-pack`: capacity growth at boundary; swap-remove correctness; dirty-range bounds. Must verify the §6 contract: changing sprites at indices 5 and 9990 produces a single `writeBuffer` covering the full span (not two writes), and CPU pack work touches only the two changed slots.
- `sprite-2d-projection`: pixel (0,0) → top-left NDC; (W,H) → bottom-right; pan + zoom + rotation correctness.
- `sprite-anchored-projection`: screen size invariant under varying camera distance.
- `sprite-billboard-basis`: orthonormality of facing/yaw/axis basis vectors at edge cases (camera straight up, camera at sprite, lock axis parallel to view).
- `sprite-sort`: re-sort triggers (version bump, camera move, count change); cutout emits sequential indirection; blended emits back-to-front; centroid is mean of visible world positions.
- `sprite-pick-billboard-uv`: GPU contributor inverse-projection produces correct UV in `[0,1]` for facing/yaw/axis variants; non-pickable sprite discards in the pick pass (verify via mock contributor); per-system base ID range works (two systems → IDs disjoint).
- `pick-contributor-registry`: lazy creation, idempotent registration, dispatch order matches registration order.
- `sprite-pick-2d`: rotation-aware hit test in `Scene2DContext`; reverse-order topmost selection.
- `sprite-pick-anchored`: rotation-aware hit test in projected screen space (per §10); reverse-order topmost selection.

### Visualization (Playwright)

- **Scene NN-sprites-2d**: pure `Scene2DContext`, 1000-sprite grid, animated atlas. Pixel-perfect grid layout. MAD threshold tight.
- **Scene NN-sprites-overlay**: `Sprite2DLayer` HUD over a 3D PBR scene. Verify HUD invariant under camera motion.
- **Scene NN-sprites-anchored**: anchored labels pinned to mesh anchors; verify pixel size invariant under zoom.
- **Scene NN-sprites-billboard-yaw**: yaw-locked tree forest seen from multiple camera angles; verify upright + camera-tracking.
- **Scene NN-sprites-billboard-facing**: blended particle puffs ordered against opaque mesh; verify back-to-front sort.
- **Scene NN-sprites-cutout-vs-blend**: side-by-side row of cutout sprites (alpha-test discard, depth-write on) and blended sprites (no discard, depth-write off) against the same opaque background; verifies both blend modes' visual contracts in one frame.
- **Scene NN-sprites-animated**: 8-frame sprite sheet at 12 fps with `?seekTime` deterministic frame.

Animated scene goldens use the `?seekTime=` pattern from existing animation parity scenes (see [16-animation-parity-testing.md](16-animation-parity-testing.md)).

### Bundle Size Ceilings

Each family in its own ratchet:

- 2D-only scene: must not include any of `sprite-anchored-*`, `sprite-billboard-*`, `picking-*`.
- Anchored-only scene: must not include `scene2d`, `sprite-billboard-*`.
- Each billboard variant: must not include the other two billboard variants.
- Sprite-free scenes: zero `sprite-*` chunks fetched.
- Mesh-only scenes (no sprite system) must NOT pull in `picking/picking-contributors.ts`'s body — only the lazy `getPickContributors` accessor reference in `gpu-picker.ts` may appear, and tree-shaking eliminates the rest.
- Scenes with billboard systems pull in `sprite/picking/billboard-pick-contributor.ts` and `sprite/picking/billboard-pick-pipeline.ts` — both are dynamic-imported by the billboard renderable, never statically.

---

## File Manifest

```
packages/babylon-lite/src/
  scene2d/
    scene2d.ts                                  # Scene2DContext + addToScene2D + removeFromScene2D + disposeScene2D
    scene2d-render-loop.ts                      # startEngine2D + renderSprite2DFrame
    scene2d-camera-ubo.ts                       # Sprite2DSceneUBO updater

  sprite/
    shared/
      sprite-atlas.ts                           # SpriteAtlas, createGrid/Named/loadSpriteAtlas, resolveSpriteFrame
      sprite-animation.ts                       # SpriteClipState, evaluate/advanceSpriteClip
      sprite-gpu.ts                             # CPU→GPU dirty-range writeBuffer, capacity grow (dynamic-imported); allocates packed buffer with VERTEX | STORAGE | COPY_DST
      sprite-pack.ts                            # Per-family packing helpers (one per family, no shared if)
      sprite-sort.ts                            # SpriteSortState + createSpriteSortState / syncSpriteSortIndices / computeSpriteCentroid / disposeSpriteSortState
      sprite-3d-instance-wgsl.ts                # Shared SPRITE_3D_DATA_WGSL (storage struct + binding) + SPRITE_3D_VS_IN_WGSL helpers (cornerOf, cornerUV, rotate2)

    sprite-2d.ts                                # createSprite2DLayer + add/update/remove/setFrame/playClip/stopClip
    sprite-2d-renderable.ts                     # Renderable builder for Sprite2DLayer (dynamic-imported)
    sprite-2d-shader.ts                         # composeSprite2D WGSL emitter

    sprite-anchored.ts                          # createAnchoredSpriteLayer + helpers
    sprite-anchored-renderable.ts               # Renderable builder
    sprite-anchored-shader.ts                   # composeAnchoredSprite WGSL emitter

    sprite-billboard-shared.ts                  # BillboardSpriteSystem common helpers (no mode `if`)
    sprite-billboard-facing.ts                  # createFacingBillboardSystem
    sprite-billboard-facing-renderable.ts
    sprite-billboard-facing-shader.ts
    sprite-billboard-yaw.ts                     # createYawLockedBillboardSystem
    sprite-billboard-yaw-renderable.ts
    sprite-billboard-yaw-shader.ts
    sprite-billboard-axis.ts                    # createAxisLockedBillboardSystem
    sprite-billboard-axis-renderable.ts
    sprite-billboard-axis-shader.ts

    picking/                                    # mirrors engine's existing src/picking/ directory
      pick-2d.ts                                # pickSprite2D
      pick-anchored.ts                          # pickAnchoredSprite
      pick-billboard.ts                         # pickBillboardSprite — dynamic-imports gpu-picker.ts; lazily creates per-scene picker
      billboard-pick-contributor.ts             # Per-system PickContributor: registers idempotently, draws into shared pick pass, resolves pickId → SpritePickInfo (incl. UV inverse-projection via system._basisFn)
      billboard-pick-pipeline.ts                # Per-(variant, isCutout) pipeline cache + 80 B per-system pick UBO layout
```

Plus, in the engine-wide `picking/` directory (one new file):

```
packages/babylon-lite/src/picking/
  picking-contributors.ts                       # Generic PickContributor interface + getOrCreatePickContributors / getPickContributors registry accessors
```

Test + scene files (mirroring existing Lite layout):

```
tests/unit/                                     # vitest unit tests (one file per § 14 unit test name)
  sprite-atlas.test.ts
  sprite-animation.test.ts
  sprite-pack.test.ts
  sprite-2d-projection.test.ts
  sprite-anchored-projection.test.ts
  sprite-billboard-basis.test.ts
  sprite-sort.test.ts
  sprite-pick-2d.test.ts
  sprite-pick-anchored.test.ts
  sprite-pick-billboard-uv.test.ts
  pick-contributor-registry.test.ts

tests/parity/scenes/                            # Playwright parity specs reference scene NN
  (parity scenes are driven by lab/sceneNN.html via the existing scene-runner)

tests/parity/bundle-size.spec.ts                # § 14 bundle ratchets added here

lab/                                            # reference scenes (NN, NN+1, … are placeholders for the next free indices in lab/)
  sceneNN.html              + src/lite/sceneNN.ts             # NN-sprites-2d
  sceneNN+1.html            + src/lite/sceneNN+1.ts           # NN-sprites-overlay
  sceneNN+2.html            + src/lite/sceneNN+2.ts           # NN-sprites-anchored
  sceneNN+3.html            + src/lite/sceneNN+3.ts           # NN-sprites-billboard-yaw
  sceneNN+4.html            + src/lite/sceneNN+4.ts           # NN-sprites-billboard-facing
  sceneNN+5.html            + src/lite/sceneNN+5.ts           # NN-sprites-cutout-vs-blend
  sceneNN+6.html            + src/lite/sceneNN+6.ts           # NN-sprites-animated
  babylon-ref-sceneNN.html  …                                 # BJS reference equivalents
  bundle-sceneNN.html       …                                 # bundle-size measurement scaffolds
  bundle-bjs-sceneNN.html   …                                 # BJS bundle baselines
```

Public-API additions to `packages/babylon-lite/src/index.ts`:

```typescript
// ─── 2D Scene ────────────────────────────────────────────────────────
export { createScene2DContext, addToScene2D, removeFromScene2D, disposeScene2D } from "./scene2d/scene2d.js";
export { startEngine2D, renderSprite2DFrame } from "./scene2d/scene2d-render-loop.js";
export type { Scene2DContext, Scene2DOptions } from "./scene2d/scene2d.js";

// ─── Sprites ─────────────────────────────────────────────────────────
export { loadSpriteAtlas, createGridSpriteAtlas, createNamedSpriteAtlas, resolveSpriteFrame } from "./sprite/shared/sprite-atlas.js";
export { createSpriteClipState } from "./sprite/shared/sprite-animation.js";
export type { SpriteAtlas, SpriteFrame, SpriteClip, SpriteSampling, SpriteBlendMode, SpriteFrameRef, SpriteClipState } from "./sprite/shared/sprite-atlas.js";

export { createSprite2DLayer, addSprite2D, updateSprite2D, removeSprite2D, setSprite2DFrame, playSprite2DClip, stopSprite2DClip } from "./sprite/sprite-2d.js";
export type { Sprite2DLayer, Sprite2DLayerOptions, Sprite2DInit, Sprite2DView } from "./sprite/sprite-2d.js";

export {
    createAnchoredSpriteLayer,
    addAnchoredSprite,
    updateAnchoredSprite,
    removeAnchoredSprite,
    setAnchoredSpriteFrame,
    playAnchoredSpriteClip,
    stopAnchoredSpriteClip,
} from "./sprite/sprite-anchored.js";
export type { AnchoredSpriteLayer, AnchoredSpriteLayerOptions, AnchoredSpriteInit } from "./sprite/sprite-anchored.js";

export { createFacingBillboardSystem } from "./sprite/sprite-billboard-facing.js";
export { createYawLockedBillboardSystem } from "./sprite/sprite-billboard-yaw.js";
export { createAxisLockedBillboardSystem } from "./sprite/sprite-billboard-axis.js";
export {
    addBillboardSprite,
    updateBillboardSprite,
    removeBillboardSprite,
    setBillboardSpriteFrame,
    playBillboardSpriteClip,
    stopBillboardSpriteClip,
} from "./sprite/sprite-billboard-shared.js";
export type { BillboardSpriteSystem, BillboardSpriteSystemOptions, BillboardSpriteInit } from "./sprite/sprite-billboard-shared.js";

export { pickSprite2D } from "./sprite/picking/pick-2d.js";
export { pickAnchoredSprite } from "./sprite/picking/pick-anchored.js";
export { pickBillboardSprite } from "./sprite/picking/pick-billboard.js";
export type { SpritePickInfo } from "./sprite/picking/pick-2d.js";
```
