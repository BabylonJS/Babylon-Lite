# Module: Text

> Package path: `packages/babylon-lite/src/text/`
>
> Slug-style GPU font rendering for Lite. Glyphs are stored as quadratic Bézier
> outlines with a spatial-band index packed into two `rgba32float` textures, and
> drawn as instanced unit quads where the fragment shader resolves analytic
> coverage from the curves intersecting each pixel's bands. The module is layered
> so the lowest level (`GlyphStorage`) holds only outlines and atlases, the
> middle level (`TextData`) layers per-instance slot allocation on top, and the
> top levels (`TextRenderable`, `TextRenderer`) attach `TextData` to either a 3D
> scene or a standalone 2D pass.

## Purpose

The text feature exists to draw resolution-independent glyphs anywhere — inside a
3D scene as a world-space `TextRenderable`, or in pure 2D as a standalone
`TextRenderer` (no scene, no camera). Both paths share one CPU layout
(`TextData` per-instance buffer + draw groups) and one GPU pipeline (Slug
fragment shader against curve+band textures). They differ only in how the MVP
matrix is composed and which render pass owns the draw.

The module is organized as four lifetime tiers, longest-lived first:

1. **`GlyphStorage`** — outlines + GPU atlases. One storage can hold many
   curve-sets (one per font face) and back many `TextData`s. Caller-owned.
2. **`TextData`** — per-text-block instance buffer + slot allocator + draw
   groups. Borrows a `GlyphStorage`. One `TextData` per logical text block.
3. **`TextRenderable`** (3D) / **`TextRenderer` + `TextLayer`** (2D) — the
   thing that gets registered with an engine/scene and actually draws.
4. **`DefaultTextData`** + helpers — convenience layer that does default LTR
   layout via `text-shaper` and ships its own private `GlyphStorage`.

Each tier depends only on the tier below it, so a caller that hand-rolls its own
layout (e.g. an external rich-text engine) imports only `GlyphStorage` +
`TextData` + a renderer and pays zero bytes for the default layout / text-shaper
glue.

## Public API Surface

### Tier 1 — `GlyphStorage` (longest-lived)

```typescript
export interface GlyphStorage {
    /* opaque */
}
export type CurveSetId = string;

export function createGlyphStorage(initial?: Map<CurveSetId, Map<number, GlyphCurves>>): GlyphStorage;
export function updateGlyphStorage(storage: GlyphStorage, curveSetId: CurveSetId, curves: ReadonlyMap<number, GlyphCurves>): void;
export function disposeGlyphStorage(storage: GlyphStorage): void;
```

A `GlyphStorage` is an opaque bundle of `(curveSetId → glyph outlines + packed
atlas)`. Each `CurveSetId` (a string, typically the font family name) maps to
exactly one atlas; one `GlyphStorage` holds an arbitrary number of curve-sets.
Glyph ids inside a curve-set are dense small integers (font glyph indices), and
once packed into the atlas a glyph's slot is never moved.

`updateGlyphStorage` is idempotent per glyph id — already-present ids are
skipped, so callers can pass the union of every glyph they might draw without
re-rasterizing. Lifetime is caller-owned (matches `Texture2D` semantics): the
caller must outlive any `TextData` that borrows the storage, then call
`disposeGlyphStorage` exactly once to release every atlas's GPU textures.

The same `GlyphStorage` can be shared by reference across any number of
`TextData`s — that is the whole reason it is a separate tier. Two text blocks
in the same font pay one atlas upload.

### Tier 2 — `TextData`

```typescript
export interface TextData {
    readonly runs: readonly GlyphRun[];
    // ... opaque internals
}

export type GlyphRun = {
    readonly curveSet: CurveSetId;
    readonly glyphs: readonly PlacedGlyph[];
    readonly pixelsPerFontUnit: number;
    readonly defaultColor?: readonly [number, number, number, number];
};
export type PlacedGlyph = {
    readonly glyphId: number;
    readonly x: number; // pixels, glyph origin
    readonly y: number; // pixels, baseline up
    readonly color?: readonly [number, number, number, number]; // overrides run defaultColor
};

export function createTextData(storage: GlyphStorage, runs?: readonly GlyphRun[]): TextData;
export function updateTextData(data: TextData, update: TextDataUpdate): void;
export function disposeTextData(data: TextData): void;

export type TextDataUpdate =
    | { update: "reset"; runs?: GlyphRun[]; storage?: GlyphStorage }
    | { update: "addRun"; run: GlyphRun; insertBefore?: number }
    | { update: "removeRun"; run: GlyphRun | number }
    | { update: "replaceRun"; previous: GlyphRun | number; run: GlyphRun };
```

A `TextData` represents one logical text block as an ordered list of
`GlyphRun`s. Each run carries the glyphs in a single font (one `curveSet`) at a
single pixels-per-font-unit scale; mixed-font / mixed-size content is just
multiple runs in the same `TextData`. The `update` API is a small discriminated
union driving the slot allocator (see §Implementation).

`disposeTextData` releases only the per-block GPU resources (instance buffer +
bind groups). It does **not** touch the borrowed `GlyphStorage` — the caller
owns that lifetime.

### Tier 3a — `TextRenderable` (3D, attached to a scene)

```typescript
export interface TextRenderableOptions {
    readonly position?: Vec3;
    readonly rotationQuaternion?: { x: number; y: number; z: number; w: number };
    readonly scaling?: Vec3;
    readonly opacity?: number; // whole-block fade. default 1
    readonly ignoreDepth?: boolean; // skip depth test/write. default false
    readonly order?: number; // sort order. default 200
}

export interface TextRenderable extends Renderable {
    readonly position: ObservableVec3;
    readonly rotation: EulerProxy;
    readonly rotationQuaternion: ObservableQuat;
    readonly scaling: ObservableVec3;
    opacity: number;
    ignoreDepth: boolean;
    order: number;
}

export function createTextRenderable(data: TextData, options?: TextRenderableOptions): TextRenderable;
export function addTextRenderable(scene: SceneContext, renderable: TextRenderable): void;
export function disposeTextRenderable(renderable: TextRenderable): void;
```

A `TextRenderable` mirrors `Mesh`'s TRS surface (`position`, `rotation`,
`rotationQuaternion`, `scaling`) and implements the standard `Renderable`
interface, so it sorts and binds like any other scene entity. It is `isTransparent`
by default (text always uses src-over blending) and consumes its `TextData`
read-only — the data and its underlying `GlyphStorage` may be shared across
many `TextRenderable`s.

Scene-attached text can opt into alpha-to-coverage with
`setAlphaToCoverage(renderable, true)` before it is added/registered. The option
is effective only when `ignoreDepth === false` and the scene target is
multisampled. That variant uses straight RGB, analytic glyph coverage as alpha,
replacement color (no blend), and per-sample depth writes. Standalone
`TextRenderer` layers draw to a 1x swapchain and retain ordinary straight-alpha
blending.

### Tier 3b — `TextRenderer` + `TextLayer` (standalone 2D)

```typescript
export interface TextLayerOptions {
    readonly positionPx?: { x: number; y: number }; // canvas pixel origin
    readonly rotationRad?: number; // z-axis rotation
    readonly scale?: number; // uniform
    readonly order?: number; // within renderer
    readonly opacity?: number;
    readonly visible?: boolean;
}
export interface TextLayer {
    readonly data: TextData;
    positionPx: { x: number; y: number };
    rotationRad: number;
    scale: number;
    order: number;
    opacity: number;
    visible: boolean;
}
export function createTextLayer(data: TextData, options?: TextLayerOptions): TextLayer;
export function setTextLayerPosition(layer: TextLayer, x: number, y: number): void;

export interface TextRendererOptions {
    layers: readonly TextLayer[];
    clear?: boolean; // default true
    clearValue?: GPUColorDict;
}
export function createTextRenderer(engine: EngineContext, opts: TextRendererOptions): TextRenderer;
export function addTextRendererLayer(tr: TextRenderer, layer: TextLayer): void;
export function removeTextRendererLayer(tr: TextRenderer, layer: TextLayer): boolean;
export function registerTextRenderer(tr: TextRenderer): void;
export function unregisterTextRenderer(tr: TextRenderer): void;
export function disposeTextRenderer(tr: TextRenderer): void;
```

`TextRenderer` is a standalone `RenderingContext` (sibling of `SpriteRenderer`):
no scene, no camera. It opens its own swapchain render pass and draws each
visible `TextLayer` in `order` order. The MVP is a pure CPU-built 2D affine
(layer position/rotation/scale + ortho projection) — there is no view matrix.
Layers can be added/removed at any time; their pixel position/rotation/scale/
opacity may be mutated directly between frames.

A scene that wants 2D HUD text on top of 3D uses `registerScene` first, then
`createTextRenderer` + `registerTextRenderer` so the text pass runs after the
scene's frame graph.

### Tier 4 — Default helpers (depend on `text-shaper`)

```typescript
export interface Font {
    /* opaque, wraps text-shaper.Font */
}
export function loadFont(url: string): Promise<Font>;
export function createFontFromBuffer(data: ArrayBuffer): Font;

export function extractGlyphCurves(font: Font, glyphIds: ReadonlySet<number>, target: Map<number, GlyphCurves>): void;
export function cubicToQuadratics(/* control points */): [QuadCurve, QuadCurve];

export interface DefaultTextData extends TextData {
    readonly width: number; // pixel-space laid-out width
    readonly height: number; // pixel-space laid-out height
}
export function createDefaultTextData(font: Font, fontSizePx: number, text: string, textColor?: [number, number, number, number], options?: TextLayoutOptions): DefaultTextData;
export function updateDefaultTextData(data: DefaultTextData, text: string, textColor?: [number, number, number, number]): void;
export function disposeDefaultTextData(data: DefaultTextData): void;
```

`createDefaultTextData` runs the default LTR + word-wrap + align layout
(`layout.ts`, built on `text-shaper`'s HarfBuzz-style shaping), extracts the
required glyph outlines from the font (`glyph-extraction.ts`, using `text-shaper`'s glyph
path provider), packs them into a fresh single-curve-set `GlyphStorage`, and
wraps the result in a `TextData` with one `GlyphRun`. The branded
`DefaultTextData` carries pixel-space `width` / `height` so callers can size
their `TextRenderable.scaling` or place a `TextLayer` precisely.

`updateDefaultTextData` re-shapes the text, appends any newly-needed glyph
outlines to the existing `GlyphStorage` (existing ids no-op via
`updateGlyphStorage`), and applies the new run via `updateTextData(replaceRun)`
— which hits the in-place rewrite fast path whenever the glyph count is
unchanged.

`disposeDefaultTextData` releases both the per-block resources and the
owned `GlyphStorage` (because this helper allocated both).

Callers driving their own text layout import only Tiers 1–3 and pay zero bytes
for `layout.ts`, `glyph-extraction.ts`, `default-text-data.ts`, or `text-shaper`'s shaping
codepath.

### Minimal example — `createDefaultTextData` + `TextRenderer`

The shortest path from font URL to rendered text on a canvas:

```typescript
import { createEngine, startEngine, loadFont, createDefaultTextData, createTextLayer, createTextRenderer, registerTextRenderer } from "@babylonjs/lite";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const font = await loadFont("/fonts/Inter.ttf");

// Shape + extract curves + pack atlas in one call (a fresh GlyphStorage is
// allocated under the hood and released by `disposeDefaultTextData`).
const data = createDefaultTextData(font, 48, "Hello, world!");

// Place the laid-out block at pixel (32, 64) on the canvas.
const layer = createTextLayer(data, { positionPx: { x: 32, y: 64 } });

// Standalone 2D renderer — no scene, no camera.
const renderer = createTextRenderer(engine, { layers: [layer] });
registerTextRenderer(renderer);

await startEngine(engine);
```

For a 3D scene, swap the last three lines for `createTextRenderable(data)` +
`addTextRenderable(scene, …)`; everything else is identical.

## Implementation

### CPU data layout

Each `GlyphStorage` curve-set owns a `SharedAtlas`:

```typescript
type SharedAtlas = {
    curveTexData: Float32Array; // rgba32float, width 4096, grows by row doubling
    curveTexelsUsed: number;
    bandTexData: Float32Array; // rgba32float, width 4096, grows by row doubling
    bandTexelsUsed: number;
    glyphSlots: Map<number, AtlasSlot>; // glyphId → curve start + band header location + band counts
    version: number; // monotonic, bumped per packAppendGlyph
    gpu: SharedAtlasGpu | null; // lazy
};
```

The two textures are fixed-width `4096` and grow in row-doubling steps. Curve
texels store quadratic control points (`p0`, `p1`, `p2` packed as two
`vec4`s per curve); band texels store per-band headers (count + offset) followed
by curve-index lists. Per-glyph metadata lives in `AtlasSlot` (curve start
texel, band header location, `(vBandCount, hBandCount)` for the fragment
shader's transform).

Each `TextData` owns a contiguous packed instance buffer (`Float32Array`, 20
floats = 5 `vec4`s = 80 bytes per instance), an `instanceCount`, and a list of
draw groups:

```typescript
type TextDataDrawGroup = {
    groupKey: TextGroupKey; // draw-group identity; === curveSetId unless a styling feature interned another
    curveSetId: CurveSetId;
    curveSet: GlyphStorageCurveSet; // cached pointer into _storage._curveSets
    slotStart: number;
    slotCount: number; // live + dead
    liveCount: number;
    freeSlots: number[]; // LIFO stack of dead slot indices
    bindGroup: GPUBindGroup | null;
    bindGroupVersion: number; // last-seen atlas.uploadedVersion
};
```

One draw group per unique `groupKey` used by the live runs — which is one per unique
`curveSetId` unless an opt-in styling feature splits a curve set further (see
"Draw-group keys"). Each group owns a
contiguous `[slotStart, slotStart + slotCount)` slot range in the shared
instance buffer; **live and dead slots intermix within that range**. The vertex
shader detects dead slots and emits a degenerate off-screen quad, so they cost
only a vertex-shader invocation. A per-run `RunRecord` tracks which absolute
slot indices each `GlyphRun` currently occupies, so add/remove/replace are O(touched glyphs).

### Per-instance layout (5 × `vec4`, 80 bytes)

| Field        | Floats | Contents                                                                                             |
| ------------ | ------ | ---------------------------------------------------------------------------------------------------- |
| `slugBounds` | 4      | `(xMin, yMin, xMax, yMax)` in font units — the quad's extent                                         |
| `slugAnchor` | 4      | `(xPx, yPx, 1/pixelsPerFontUnit, deadSentinel)` — pixel origin + scale; `.w = 1` marks the slot dead |
| `slugAtlas`  | 4      | `(glyphLocX, glyphLocY, bandMaxX, bandMaxY)` — band texture lookup base + max band indices           |
| `slugBand`   | 4      | `(bandScaleX, bandScaleY, bandOffsetX, bandOffsetY)` — derived from glyph bounds + band counts       |
| `slugColor`  | 4      | linear RGBA per glyph (falls back to run `defaultColor`, then white)                                 |

The vertex shader reads `slugAnchor.w` first; when non-zero it emits a
clip-space point at `(-2, -2, -2, 1)` so all six quad vertices collapse to one
off-screen point and rasterization culls the zero-area triangles.

### Slot allocator (fast incremental updates)

The allocator is the heart of the module — its purpose is to make
`updateTextData` cheap enough that a typing user can drive it on every
keystroke without rebuilding GPU buffers.

- **`addRun`** allocates one slot per glyph, first by popping from the owning
  group's `freeSlots` LIFO (a dead slot vacated by a prior `removeRun`), then
  by extending the group's range. Extending requires `copyWithin`-shifting
  every later group right by `extraSlots`; same-group runs are never shifted
  because slots within a group are unordered.
- **`removeRun`** writes the dead-slot sentinel into every slot the run
  occupied and pushes those slot indices into the group's `freeSlots`. If the
  group becomes empty (no live runs) it is dropped and later groups shift left
  to close the gap. Removed slots dirty the buffer range `[minSlot, maxSlot+1]`.
- **`replaceRun`** has a fast path: same curveSet + same glyph count → rewrite
  the existing slots in place (no allocator work, no buffer shift). This is
  the path `updateDefaultTextData` hits when the user types a single character
  into a line that didn't word-wrap. Different size or different curveSet
  falls back to `removeRun` + `addRun` at the same `runs` index.
- **`reset` (full or compaction)** rebuilds groups + slot ranges from scratch,
  re-using existing group records when the curveSet matches (preserves
  `bindGroup` identity when the atlas pointer is unchanged) and packing every
  live slot contiguously without gaps. Calling `updateTextData(data, { update: "reset" })`
  with both `runs` and `storage` omitted is therefore a pure compaction pass.

**Automatic vs manual compaction.** The allocator does compact automatically
in two cases: (a) dead slots within a group are always reclaimed by the next
`addRun` / `replaceRun` via the `freeSlots` LIFO, so freed slots are not lost,
they just sit dormant in-place; and (b) a group whose `liveCount` reaches zero
is dropped wholesale by `dropEmptyGroup`, shifting later groups left to close
the gap. What is **not** automatic is intra-group hole closing while the group
is still live: if a 200-glyph run shrinks to 5 glyphs the other 195 slots
remain dead until a future run reuses them or the caller invokes `reset`. The
vertex shader collapses dead slots to a single off-screen point (a cheap
vertex invocation, no fragment work), so the steady-state cost is bounded —
an explicit `reset` is only needed if a workload spends a long time with a
large dead-slot fraction and the caller wants the GPU instance buffer to
shrink. Adding an internal heuristic (e.g. auto-reset when `dead / total > 0.5`)
is a future option but not currently implemented.

### Dirty range + version-based GPU upload

`TextData` carries a `_version` (bumped per mutation) and a `[_dirtyStart, _dirtyEnd)`
half-open dirty range. Every allocator path that writes the instance buffer
calls `markDirty(data, minSlot, maxSlot + 1)`. The GPU side
(`TextRenderable` / `TextRenderer`) caches `uploadedDataVersion` and at frame
upload time:

1. If `data._version === uploadedDataVersion` → skip entirely.
2. Else if a partial upload is safe (`uploadedDataVersion !== -1` and the
   dirty range is non-empty) → `writeBuffer` only the dirty subrange.
3. Else (post-reset or post-resize) → upload the whole prefix
   `[0, _instanceCount)`.

The instance GPU buffer doubles capacity when needed; on resize the next upload
falls into branch 3.

`SharedAtlas.version` plays the same role for the curve+band textures.
`ensureSharedAtlasGpu(device, atlas)` lazily allocates the textures, grows them
(power-of-two rows) when capacity needs change, and re-uploads only when
`uploadedVersion !== atlas.version`. It returns `{ rebuilt, gpu }`; `rebuilt =
true` (texture object identity changed) is the signal for the renderer to drop
every draw group's `bindGroup` so it gets re-created against the new texture
views. Same-version polls during steady-state are a single integer compare.

### Spatial-band index (internal to `glyph-storage.ts`)

For each glyph, `buildGlyphBands(glyph)` partitions the curves into up to 8
horizontal and 8 vertical bands by bounding-box overlap. Curves within an
h-band are sorted by descending `max(p0x, p1x, p2x)` (and v-bands by
descending `max(p0y, p1y, p2y)`) so the fragment shader can early-exit a band
as soon as a curve is entirely to the left/below the pixel. The result is
memoized on the `GlyphCurves` object via a `@internal _bands?` field so a
glyph re-used by a second `GlyphStorage` (e.g. another text block re-extracting
from the same `Font`) pays the band-build cost only once.

### Pipeline (`_gpu/text-pipeline.ts`)

One bind group layout + one pair of base WGSL modules cached per `GPUDevice` (a
`WeakMap<GPUDevice, TextPipelineDeviceCache>`). The render pipeline itself is
cached per fixed-arity
`(colorFormat, sampleCount, depthStencilFormat, depthWrite, alphaToCoverage, variantId)`
key — so a `TextRenderable` with `ignoreDepth=true` and a `TextRenderable`
with `ignoreDepth=false` share modules + bind group layout but get separate
pipelines. Optional shader variants are supplied as already-compiled opaque module
pairs by an opt-in feature; see "Variant module lifecycle" below.

Blend is fixed src-over:

```
color: (src.a * src.rgb) + (1 - src.a) * dst.rgb
alpha: src.a + (1 - src.a) * dst.a
```

Topology is `triangle-list` (two triangles per glyph from a shared 6-vertex
unit-quad buffer). The bind group has three entries: the `TextU` UBO (mvp +
viewport + color) on binding 0, and the curve / band textures on bindings 1
and 2 (both `texture_2d<f32>` as `unfilterable-float`).

### WGSL outline

Both shader stages are direct WGSL ports of Eric Lengyel's Slug algorithm
([github.com/EricLengyel/Slug](https://github.com/EricLengyel/Slug)) — the
curve+band atlas layout, the per-pixel band lookup, the quadratic root-code
table, and the screen-space dilation math all come from that reference
implementation. The Babylon Lite shaders are the same algorithm reshaped to
fit Lite's instance-buffer + bind-group plumbing.

The vertex stage (the vertex half of `shaders/slug-shader.ts`):

1. **Dead-slot detection.** `if (slugAnchor.w > 0.5) → emit (-2,-2,-2,1) point`.
2. **Quad corner expansion.** `tex = mix(slugBounds.xy, slugBounds.zw, isMax)`
   maps the unit corner sign to the glyph's font-unit bounds; `pos = slugAnchor.xy + tex * scale`
   puts the corner in object-space pixels.
3. **Slug dilation** (Eric Lengyel's analytic AA expansion) — extracts MVP
   rows, computes a screen-space dilation vector `d` proportional to
   `(1 / viewport, 1 / viewport)` so glyph edges always cover one fragment.
   Also dilates the texcoord by the inverse glyph Jacobian.
4. Outputs the dilated clip position + dilated `vTexcoord` + flat
   `vBanding` / `vGlyph` / `vColor`.

The fragment stage (the fragment half of `shaders/slug-shader.ts`):

1. From `vTexcoord`, derive `(hBandIndex, vBandIndex)` via
   `bandScale * tex + bandOffset` clamped to `[0, bandMax]`.
2. Read the band's header (count + curve-list offset) from `bandTex` at
   `glyphLoc + bandIndex`.
3. Walk the curve-index list; for each curve, fetch its two `vec4`s from
   `curveTex` and solve the horizontal (and vertical for v-bands) polynomial
   to count signed crossings using the standard Loop-Blinn 3-bit root-code
   table (`0x2E74`). Early-exit when sorted-curve x/y is past the pixel.
4. Accumulate signed coverage from h-bands and v-bands and average; clamp
   to `[0, 1]`; multiply by `vColor`. Output the result.

The shader is independent of the layout / curve-extraction path — it consumes
only the packed atlas + instance buffer.

### `TextRenderable` (3D) per-frame

`TextRenderable` is a `Renderable` with `isTransparent = true`. Its `bind` is
called by the scene's frame graph; `update` does:

0. **Late-installed variant refresh.** `bind` resolves both pipelines, but scene
   bindings are built once — not per frame — so a styling feature enabled *after*
   a binding exists would otherwise leave its weighted groups drawing with the base
   pipeline until an unrelated scene mutation rebuilt the binding. The binding's
   `update` therefore re-resolves the variant pipeline exactly once, when
   `gpu._variantPipeline === gpu._pipeline && _textVariantResolver` — an identity
   comparison that a base consumer fails on its first term and that stops matching
   after the single refresh, so no cache key is ever built per frame. The
   re-resolution reuses the *bind-time* target arguments captured in the binding
   closure (`colorFormat`, `sampleCount`, `depthStencilFormat`, `depthWrite`, and the
   renderable itself as the alpha-to-coverage owner), so the refreshed variant is the
   exact sibling of the base pipeline the binding already declares.
1. For each draw group: `ensureSharedAtlasGpu` (uploads / regrows curve+band
   textures); rebuild `bindGroup` when atlas was rebuilt or `bindGroupVersion`
   is stale.
2. Resize / re-upload the instance buffer per the version + dirty-range
   protocol above.
3. Compose MVP into a 16-float scratch from the active camera's view-projection
   × the renderable's world matrix; `writeBuffer` to the `TextU` UBO offset 0.
   Skip the recompute + upload when the world matrix is clean **and** the
   camera's `worldMatrixVersion` and effective aspect are both unchanged.
4. Write viewport size at UBO offset 64 (16 bytes) when target size changed.
   Write `(1, 1, 1, opacity)` at UBO offset 80 when opacity changed.

`draw` then iterates the draw groups: bind the group's pipeline (base, or the
pre-resolved variant when `g.groupKey !== g.curveSetId`, deduped against the
currently bound one); `setBindGroup(0, g.bindGroup)`;
`pass.draw(6, g.slotCount, 0, g.slotStart)`. There is one draw call per
non-empty group, and `slotCount` includes dead slots (which collapse in the
vertex shader). If any variant group was bound, the base pipeline is re-bound
before returning so the draw list's `setPipeline` dedupe stays valid for the next
renderable. Crucially, `TextRenderable` does **not** bind the scene's
shared scene-UBO at group 0 — it composes its own MVP so the same pipeline can
run from a `TextRenderer` with no scene at all.

### `TextRenderer` (2D) per-frame

`TextRenderer` is a `RenderingContext` registered via `registerTextRenderer`.
`startEngine` calls its `_update` (per-layer GPU sync) and `_record` (opens a
swapchain render pass and emits per-layer draws) once per frame.

The MVP for a 2D layer is built directly:

```
[ cos·(2s/W)   sin·(2s/W)   0   (2·px/W - 1)  ]
[ -sin·(2s/H)  cos·(2s/H)   0   (1 - 2·py/H)  ]
[ 0            0            1   0             ]
[ 0            0            0   1             ]
```

A 6-float `lastMvpInputs` cache (px, py, rot, scale, W, H) gates the MVP
writeBuffer so a static layer pays zero per frame after the first.

The renderer's pipeline is cached at `(swapchain format, sampleCount=1, no
depth, depthWrite=false, flipY=false)`; depth-less means depth-hosted text-on-3D
must use `TextRenderable` instead. Layers are sorted by `order` once per frame
when there are >1; per-layer GPU records (`LayerGpu`) hold one bind group per
draw group plus an `instanceBuf` and a `textU` UBO.

### Default layout (`layout.ts`)

`layoutText(font, text, fontSizePx, options)` runs LTR shaping per paragraph
(`text-shaper.shape` returns positioned glyph clusters), greedy word wrap at
`maxWidth`, optional alignment, then bakes a flat `PlacedGlyph[]` with
pixel-space positions:

- Y is up: line 0 sits at `y=0`, subsequent lines at `y = -lineIdx * lineHeightPx`.
  This pairs naturally with the font's em-space Y-up bounds so a 3D scene with
  a Y-up camera renders text upright with no extra transform.
- `pixelsPerFontUnit = font.scaleForSize(fontSizePx)` is returned alongside;
  the `GlyphRun` consumes it and the per-instance `slugAnchor.z = 1 / scale`
  drives the vertex shader's em→pixel transform.

### Default curve extraction (`glyph-extraction.ts`)

`extractGlyphCurves(font, glyphIds, target)` walks `text-shaper.getGlyphPath`
for each requested id, converts every command (`M`, `L`, `Q`, `C`, `Z`) into
quadratic Bézier segments, and stores the result in `target`. `L` is split into
a degenerate quadratic (control point at midpoint); `C` is split into two
quadratics via the "3/4 rule" (exposed publicly as `cubicToQuadratics` for
callers that ingest their own cubic outlines from DirectWrite / FreeType / etc).

`Font._curvesCache` memoizes per-glyph extraction across calls, so a second
`createDefaultTextData` with the same font re-uses the already-rasterized
outlines.

## Dependencies

- `text-shaper` (npm) — used by `font.ts` (font loading), `layout.ts`
  (shaping), and `glyph-extraction.ts` (glyph path extraction). Only the default-layout
  / default-curves modules import it; callers using hand-rolled layout pay zero
  bytes for it.
- `engine/engine.ts` — `EngineContext`, `RenderingContext` (TextRenderer
  registration), `getRenderTargetSize`.
- `engine/render-target.ts` — `RenderTargetSignature` (TextRenderable
  pipeline key).
- `render/renderable.ts` — `Renderable`, `DrawBinding`, `DrawUpdateContext`
  (TextRenderable contract).
- `scene/scene-core.ts` — `addDeferredSceneRenderables` (`addTextRenderable`
  attachment).
- `camera/camera.ts` — `getViewProjectionMatrix`,
  `getEffectiveAspectRatio` (TextRenderable per-frame MVP composition).
- `math/observable-vec3.ts`, `math/observable-quat.ts`,
  `math/mat4-compose.ts`, `math/mat4-multiply-into.ts`,
  `scene/world-matrix-state.ts`, `scene/scene-node.ts` — TRS + world
  matrix plumbing reused from Mesh.
- `resource/gpu-buffers.ts` — `createEmptyUniformBuffer` for the `TextU`
  UBO.

## Reference scenes

- **Scene 180 — `scene180-text-renderer`**: standalone 2D `TextRenderer` +
  `TextLayer` driven by a `<textarea>` + sliders. Demonstrates pure-2D path
  (no scene, no camera), live `updateDefaultTextData`, color slider routed
  through a `replaceRun` op, drag-to-move, wheel-to-scale.
- **Scene 181 — `scene181-text-editor`**: 3D `TextRenderable` attached to an
  arc-rotate scene, driven by a `<textarea>` calling `updateDefaultTextData`
  on every keystroke. Demonstrates in-place atlas growth and instance-buffer
  reuse — typing a new character extends the atlas with that glyph's outlines
  and rewrites the run via `replaceRun`'s in-place fast path when the glyph
  count is unchanged.

Both scenes are tagged `skipParity` and `skipPerf` (interactive demos, no
golden-image oracle).

## Test specification

Unit tests live in `tests/lite/unit/`:

- `text-glyph-storage.test.ts` — covers `GlyphStorage` ownership semantics:
  `disposeTextData` does not touch the borrowed storage; one `GlyphStorage`
  backs multiple `TextData`s; `disposeGlyphStorage` is idempotent and tears
  down every curve-set's atlas; `updateGlyphStorage` extends an existing
  curve-set and creates new ones on demand; `reset` with no args performs
  compaction (re-lays-out slots and frees dead-slot gaps).
- `text-color.test.ts` — covers per-glyph `PlacedGlyph.color` overriding the
  run's `defaultColor`, and `defaultColor` propagating to glyphs that omit
  their own color.

## File inventory

| File                              | Responsibility                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/text/font.ts`                | `Font` (branded type) + `loadFont` + `createFontFromBuffer`; text-shaper boundary.                                                                                                                                                                                                                                     |
| `src/text/glyph-extraction.ts`    | `extractGlyphCurves` + `cubicToQuadratics`; default text-shaper-backed glyph path extraction. Outline value types live in `glyph-storage.ts`.                                                                                                                                                                          |
| `src/text/glyph-storage.ts`       | `GlyphStorage` (branded) + `CurveSetId` + outline value types (`QuadCurve`, `GlyphBounds`, `GlyphCurves`) + the supporting `SharedAtlas` / `AtlasSlot` / `GlyphBands` types and their packers (`packAppendGlyph`, `buildGlyphBands`). Public API: `createGlyphStorage` / `updateGlyphStorage` / `disposeGlyphStorage`. |
| `src/text/layout.ts`              | `TextLayoutOptions` + `layoutText` — default LTR + word-wrap + align layout via `text-shaper.shape`.                                                                                                                                                                                                                   |
| `src/text/text-data.ts`           | `TextData` (branded) + `GlyphRun` + `PlacedGlyph` + `TextDataUpdate` + slot-allocator types. Public API: `createTextData` / `updateTextData` / `disposeTextData` and the per-instance allocator (addRun / removeRun / replaceRun / reset+compaction).                                                                  |
| `src/text/default-text-data.ts`   | `DefaultTextData` (branded) + `createDefaultTextData` / `updateDefaultTextData` / `disposeDefaultTextData`; convenience layer composing layout + curve extraction + a private `GlyphStorage`.                                                                                                                          |
| `src/text/text-renderable.ts`     | `TextRenderable` + `createTextRenderable` / `addTextRenderable` / `disposeTextRenderable`; 3D `Renderable` implementation.                                                                                                                                                                                             |
| `src/text/text-renderer.ts`       | `TextLayer` (2D pixel-space placement record) + `TextRenderer` (standalone `RenderingContext`) + their factories and the swapchain draw pass.                                                                                                                                                                          |
| `src/text/_gpu/text-textures.ts`  | `ensureSharedAtlasGpu`; lazy `rgba32float` texture create + version-gated upload + capacity grow. (Atlas teardown is inlined in `disposeGlyphStorage` to avoid a circular import.)                                                                                                                                     |
| `src/text/_gpu/text-pipeline.ts`  | `getOrCreateTextPipeline` / `getTextPipelineCache` / `clearTextPipelineCache` + the `TextPipelineVariant` seam; per-device bind group layout + base WGSL modules + per-target-key pipeline cache. Knows nothing about shader fragments and composes no WGSL.                                                            |
| `src/text/shaders/slug-shader.ts` | **The single authoritative copy of the Slug WGSL.** Inline TypeScript template + `composeSlugShader(fragment)` — a deterministic builder that interpolates an optional `TextShaderFragment` into the base vertex/fragment source at named slots. Called with `null` for the base variant. |
| `src/text/shaders/text-shader-fragment.ts` | Type-only module: `TextShaderFragment`, `TextVertexSlot`, `TextFragmentSlot`. Feature-agnostic — no font-weight (or any other feature's) semantics. Erased at build time. |
| `src/text/set-font-weight-offset.ts` | Opt-in feature entry point: `setFontWeightOffset(data, run, offset)`. Owns the per-run offset map, the interned draw-group keys, and the per-`GPUDevice` composed+compiled variant module pair; validates and resolves the run against its `TextData`, installs the `text-data` styling seam and the `text-pipeline` variant resolver on first effective call, then repacks the data through `updateTextData({ update: "reset" })`. |
| `src/text/shaders/weight-shader-fragment.ts` | The weight-only `TextShaderFragment`: distance-to-quadratic helper, bounded nearest-contour band scan, weight varying, quad inflation, and unsigned-distance coverage expansion. Contains **no** copy of any base Slug logic. Reachable only from `set-font-weight-offset.ts`. |

---

## Slug shader composition

### One template, many variants

There is exactly **one** copy of the base Slug vertex and fragment logic, and it lives
in `src/text/shaders/slug-shader.ts` as an inline TypeScript template. There are no
`slug.vert.wgsl` / `slug.frag.wgsl` `?raw` files, and there is no second "weighted"
copy of the shader: optional features contribute *incremental* WGSL through a typed
fragment that the template interpolates at named slots.

```typescript
export function composeSlugShader(fragment: TextShaderFragment | null): ComposedSlugShader;

export interface ComposedSlugShader {
    /** @internal Composed vertex WGSL. */ readonly _vert: string;
    /** @internal Composed fragment WGSL. */ readonly _frag: string;
    /** @internal Fragment id ("" for the base variant) — folded into the pipeline cache key. */
    readonly _key: string;
}
```

This mirrors the material stack's `ShaderTemplate` + `ShaderFragment` + `composeShader`
model (`src/shader/fragment-types.ts`, `src/shader/shader-composer.ts`), but is a
compact text-specific builder rather than a second instance of the generic material
composer: text owns a fixed custom `@group(0)` layout (uniform + curve texture + band
texture + glyph-metadata storage + style storage) with no mesh/material UBO, no shadow
group, no vertex-attribute negotiation and no UBO layout computation, so none of the
generic composer's machinery applies.

Interpolation is **direct** (`${...}` into the template literal), not marker
substitution and not a regex pass over emitted WGSL. Production bundles minify inline
WGSL template literals (`scripts/wgsl-minify-plugin.ts` → `renderChunk`), which strips
`//` comments and collapses whitespace; anything that depended on comment markers or on
parsing the emitted string would break there (see GUIDANCE "Never parse emitted WGSL
strings"). A builder that concatenates known strings is immune.

### Injection slots

`TextShaderFragment` is a pure-type description (`src/text/shaders/text-shader-fragment.ts`):

```typescript
export type TextVertexSlot = "VO" | "VD" | "VB" | "VA";
export type TextFragmentSlot = "FI" | "FH" | "CO";

export interface TextShaderFragment {
    /** @internal Stable id — part of the pipeline cache key and the shader module label. */
    readonly _id: string;
    /** @internal */ readonly _vertexSlots?: Partial<Record<TextVertexSlot, string>>;
    /** @internal */ readonly _fragmentSlots?: Partial<Record<TextFragmentSlot, string>>;
}
```

| Slot | Stage    | Location                                                                     | Contract                                                                                                                                                     |
| ---- | -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VO` | vertex   | End of the `VOut` struct body                                                | Comma-terminated member declarations. Locations `0..3` are taken by the base varyings, so fragments start at `@location(4)`.                                  |
| `VD` | vertex   | Dead-slot early-return block                                                 | Statements assigning a defined value to every member the fragment added, on the local `d: VOut`.                                                              |
| `VB` | vertex   | After `md` (glyph metadata) and `sy` (style) are in scope, before quad setup | Statements that **must** declare `let sb: vec4<f32>` — the shaped em-space glyph bounds. When the slot is present the template uses `sb` in place of `md.b`; when absent the template names `md.b` directly, so the base variant pays nothing. Values declared here stay in scope for `VA`. |
| `VA` | vertex   | Just before `return out;`                                                    | Statements assigning the fragment's added varyings on `out`.                                                                                                 |
| `FI` | fragment | End of the `FIn` struct body (before `@builtin(front_facing)`)               | Comma-terminated member declarations mirroring `VO`.                                                                                                          |
| `FH` | fragment | Module scope, after the base helpers, before `@fragment fn main`             | Helper function / constant declarations. The base helpers (`rcode`, `solveH`, `solveV`, `ccov`, `cwgt`, `bloc`) and the `ct` / `bt` textures are already in scope, so a fragment that needs its own scan of the glyph's band lists writes it here as a self-contained function. |
| `CO` | fragment | After base `cov` is computed and clamped, before the coverage-gamma `pow`    | Statements that may read and reassign `var cov: f32` (coverage in `[0,1]`). In scope: `rc` (em-space render coord), `pe` (pixels-per-em), `gp` (glyph texel origin), `bm` (max band indices), `in`. The gamma, the `a2c` premultiply select, and the final color write stay in the template. |

There are deliberately **no** per-curve slots inside the base band loops. Those loops
`break` as soon as a curve is behind the pixel along the band's sort axis, and they only
ever visit the single band that contains the pixel — both correct for coverage, both
wrong for anything that needs *nearest-contour* information (see "Why the weight fragment
owns its own scan"). A feature that needs a different traversal writes its own bounded
scan in `FH` rather than piggy-backing on a loop whose exit condition it does not control.

Slot ids are short because they are WGSL-adjacent identifiers in a size-sensitive path;
they are enumerated as a union type, so a typo is a compile error rather than a silently
ignored injection.

### Base variant is free

`composeSlugShader(null)` emits exactly the base shader: no extra varying, no helper, no
coverage override — the slot expressions collapse to `""` and the bounds expression names
`md.b` directly. Unweighted (base) draw groups therefore execute behaviourally identical
shader code to the pre-feature engine, with zero extra fragment-shader work.

### Variant module lifecycle

`src/text/_gpu/text-pipeline.ts` knows nothing about shader fragments and never composes
WGSL. It accepts an already-compiled, opaque module pair:

```typescript
/** @internal Opaque compiled shader-module pair for one composed text shader variant. */
export interface TextPipelineVariant {
    /** @internal Stable id — the variant field of the pipeline cache key. */
    readonly _id: string;
    /** @internal */ readonly _vertModule: GPUShaderModule;
    /** @internal */ readonly _fragModule: GPUShaderModule;
}

/** @internal Installed by an opt-in text styling feature; resolves that feature's compiled
 *  module pair for a device. Null until a feature installs one. */
export let _textVariantResolver: ((device: GPUDevice) => TextPipelineVariant) | null;
/** @internal */ export function _installTextVariantResolver(resolve: (device: GPUDevice) => TextPipelineVariant): void;
```

- **The feature owns composition and compilation.** `set-font-weight-offset.ts` calls
  `composeSlugShader(WEIGHT_SHADER_FRAGMENT)` and `device.createShaderModule` itself, and
  memoizes the resulting `TextPipelineVariant` in a lazily created
  `WeakMap<GPUDevice, TextPipelineVariant>` (no module-level allocation, auto-invalidating
  per device — GUIDANCE §4). The core cache holds no variant module fields at all, so a
  second feature can never overwrite or inherit another's stale modules.
- **One styling feature at a time.** The resolver is a single nullable slot; installing a
  second feature replaces the first. The group-key seam (below) and the variant resolver
  are installed together by the same feature, so they cannot disagree.
- The pipeline cache key is **fixed arity**, six `:`-separated fields, every field always
  present:
  `format : sampleCount : depthStencilFormat|"-" : "w"|"r" : "a"|"-" : variantId|"-"`.
  There is no optional field and no delimiter alias, so a base A2C pipeline
  (`…:a:-`) can never collide with a variant whose id happens to be `"a"` (`…:-:a`).
- Alpha-to-coverage stays a **pipeline-overridable constant** (`@id(0) override a2c`) on
  whichever module the pipeline uses — one module still serves both the blended and the
  A2C pipeline for each variant.

### Pipeline selection per draw group

`getOrCreateTextPipeline` returns both pipelines for a target signature:

```typescript
export interface TextPipelineSet {
    /** @internal Base Slug pipeline. */ _pipeline: GPURenderPipeline;
    /** @internal Composed-variant pipeline; **aliases `_pipeline`** when no styling feature
     *  is installed, so draw paths can bind it unconditionally. */ _variantPipeline: GPURenderPipeline;
    /** @internal */ _cache: TextPipelineDeviceCache;
}
```

Resolution happens once per bind (`TextRenderable`) / once per frame update
(`TextRenderer`) and is stored on the per-renderable / per-layer GPU record — never inside
the draw loop, which does no map lookups and builds no key strings. A `TextRenderable`
binding additionally re-resolves its variant pipeline once if a styling feature was
installed *after* the binding was built (see "`TextRenderable` (3D) per-frame" step 0);
the `TextRenderer` path needs no equivalent because its `_update` already resolves both
pipelines every frame. Draw paths that only need the shared quad buffer or bind-group
layout call `getTextPipelineCache(engine)` instead, which is a single `WeakMap` get.

A draw group selects between the two with one identity comparison,
`g._groupKey === g._curveSetId` (see "Draw-group keys"), tracks the currently bound
pipeline locally, and — in the `TextRenderable` path, which shares an encoder with the
scene's draw list — restores the base pipeline before returning so the caller's
`setPipeline` dedupe stays valid for the next renderable. The `TextRenderer` path records
into a render bundle whose state does not outlive `executeBundles`, so it needs no restore.

### Tree-shaking

- `text-shader-fragment.ts` is types only → zero runtime bytes.
- `slug-shader.ts` (base template + builder) is reached from `text-pipeline.ts`, so every
  text consumer carries it — exactly one copy, as before.
- `weight-shader-fragment.ts` is imported **only** by `set-font-weight-offset.ts`. A
  consumer that does not import `setFontWeightOffset` never reaches it, so the
  distance-to-quadratic WGSL, the band scan, the weight varying and the coverage override
  are absent from the bundle. `tests/lite/build/text-shader-fragment-treeshake.test.ts`
  asserts both directions against the real shipped `build/lib` output.
- `text-data.ts` carries no font-weight semantics. It knows only an optional per-run style
  parameter and an opaque draw-group key whose default is the run's own `CurveSetId`.

---

## Opt-in feature: synthetic font-weight offset

### Purpose

A synthetic contour offset (emboldening) per `GlyphRun`, evaluated
analytically in the Slug fragment shader. This is **not** CSS font-weight face selection
(100–900); it is a non-negative contour offset in font design units that thickens the
rendered outlines by expanding them outward. Round
contour joins fall out of the distance field automatically; an opt-in miter wedge restores
sharp joins whose reach is at most 2.5 times the contour offset.

The feature owns all of its cost at its enabler: importing `setFontWeightOffset` pulls in
the weight shader fragment; calling it with an offset that actually changes a run installs
the two core seams and composes the variant shader. Consumers that never import the setter
pay zero shader bytes and zero shader work.

### Public API

```typescript
export function setFontWeightOffset(data: TextData, run: GlyphRun | number, offset: number): void;
```

| Parameter | Type                | Description                                                                                                                                                                                                       |
| --------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data`    | `TextData`          | The `TextData` that owns the run. The setter mutates live data: it repacks and regroups `data` immediately, exactly like a setter on a live material.                                                              |
| `run`     | `GlyphRun \| number` | The run to weight, as either its `GlyphRun` reference or its current index in `data.runs`. Must be a live run of `data`; anything else throws with the same message shape `updateTextData` uses.                    |
| `offset`  | `number`            | Contour offset in **font design units** (the space of `GlyphCurves.bounds`). Positive = bolder. Must be finite; clamped to `[0, 100]` with a `console.warn`. Zero clears a previously set offset.                          |

```typescript
import { setFontWeightOffset, createDefaultTextData, loadFont } from "@babylonjs/lite";

const font = await loadFont("/fonts/Inter.ttf");
const data = createDefaultTextData(font, 48, "Bold text");
setFontWeightOffset(data, data.runs[0]!, 10); // +10 font units
setFontWeightOffset(data, 0, 10); // identical: runs may be addressed by index
setFontWeightOffset(data, 0, 0); // back to the base pipeline
```

It takes the owning `TextData` — not a bare `GlyphRun` — because runs are packed
**synchronously**. `createTextData` / `createDefaultTextData` pack their runs before they
return, and `updateTextData` packs each edit as it is applied, so a setter that only
recorded state on a detached run descriptor could never affect data that already existed;
on a `DefaultTextData` (whose single run is created and packed inside the factory) there is
no moment at which such a call could be made at all. Owning the `TextData` lets the setter
repack and regroup on the spot, so the call works at any point in the data's life,
including after it is already bound and rendering.

### Setter lifecycle

1. **Validate the offset.** Non-finite → `console.error`, return. Nothing is installed and
   nothing is repacked.
2. **Resolve the run against `data`.** `_resolveRunRef(data, run, "setFontWeightOffset")`
   (`text-data.ts`) accepts a `GlyphRun` reference that is live in `data` or an in-range
   index into `data.runs`, and throws otherwise — same wording as the `updateTextData`
   errors (`… : run index N out of range (0..M).` / `… : GlyphRun reference is not in this
   TextData.`). `updateTextData`'s own index path shares this helper, so the two can never
   drift.
3. **Clamp** to `[0, 100]` with a `console.warn` when out of range.
4. **Prepare miter metadata** for every glyph referenced by the run when the clamped offset
   is nonzero. The feature replays the curve atlas's deterministic append layout and writes
   one unit miter vector into the otherwise-unused `.zw` components of each curve's second
   texel. Preparation is cached by atlas + glyph id, so later slider changes do no join work.
   If at least one accepted vector changes staging data, incrementing the atlas's existing
   `_version` causes it to upload during the next renderer update; glyphs with no accepted
   joins do not trigger an upload. No synchronous GPU work occurs in the setter. Zero calls
   perform no preparation. The same hook runs whenever
   TextData evaluates a run's group key, so swapping a weighted `TextData` to a replacement
   `GlyphStorage` prepares that atlas during the reset rather than briefly rendering round
   joins.
5. **No-op detection.** If the resolved run's current effective offset already equals the
   clamped value, return after the cached preparation check: no seam install, no shader
   composition, and no TextData `_version` / `_layoutVersion` churn. A zero call on a run
   that never had an offset is therefore a *true* no-op — it does not install the feature or
   compile its shader — while the first nonzero call always installs.
6. **Capture** the `WeakMap`'s exact prior entry for this run — whether it had one at all,
   and its value — then **store** the clamped offset (zero deletes the entry), then
   **install the seams** (`_installTextStyleSeam` + `_installTextVariantResolver`),
   idempotently.
7. **Repack** via `updateTextData(data, { update: "reset" })` — the narrowest existing
   TextData operation that both re-reads every run's draw-group key and rewrites every
   style entry's `params.y`. `reset` with no `runs` keeps the current run objects (it
   defensively copies `data._runs`), compacts the slot allocator, and reuses the previous
   draw-group objects per key, so a run moving between the base and weighted groups is a
   regrouping — not a rebuild of the caller's descriptors. The feature deliberately
   re-implements none of the allocator, grouping or style-packing logic.
8. **Roll back on failure.** If step 7 throws (e.g. the run's curve set is no longer in
   `data`'s storage), the `WeakMap` entry written in step 6 is restored to its exact prior
   state — deleted if the run had no entry before this call, set back to the previous value
   if it did — before the error is rethrown unchanged. Without this, a failed repack would
   leave the map at the *new* offset while the data itself was never actually repacked; a
   caller that fixes the failure and retries with the same offset would then hit the no-op
   guard in step 5 and get silent non-repair instead of a retry. Prepared miter texels and
   the seams installed in step 6 are **not** rolled back — both are monotonic, idempotent,
   and side-effect-free until a run actually
   uses them, and re-running `ensureInstalled` on a retry is a no-op, so leaving them
   installed after a failed call is harmless.

Zero therefore both clears the offset and returns the run's group to the base key (and the
base pipeline) in the same call.

### `DefaultTextData` and run replacement

`createDefaultTextData` packs its single run before returning, so the setter is usable
immediately: `setFontWeightOffset(data, data.runs[0]!, 10)` (or `setFontWeightOffset(data, 0, 10)`).

`updateDefaultTextData` re-shapes the text into a **new** `GlyphRun` descriptor and applies
it with `replaceRun`. Offsets are keyed by run identity, so they do **not** transfer to the
replacement run: the block returns to the base pipeline until the caller re-applies
`setFontWeightOffset(data, 0, offset)` on the new run (index form is the convenient one
here, since the reference changed). This is deliberate — a generic "carry per-run feature
state across replaceRun" seam would put feature semantics back into `text-data.ts` and cost
every text consumer bytes for a transfer no base consumer can use. The same holds for any
caller-driven `updateTextData({ update: "replaceRun" | "reset", runs })` that swaps run
descriptors.

### The core styling seam

`text-data.ts` exposes exactly one nullable seam object and one opaque type:

```typescript
/** @internal Opaque draw-group identity, compared by `===` only. The default is the run's
 *  own `CurveSetId`; a styling feature may substitute an interned non-string token, which
 *  by construction can never equal a curve-set id. */
export type TextGroupKey = CurveSetId | object;

/** @internal */
export interface TextStyleSeam {
    /** @internal Prepare feature-owned data for this run and its current TextData. */
    _prepare(data: TextData, run: GlyphRun): void;
    /** @internal Draw-group key for a run — `run.curveSet` unless the run needs a different
     *  pipeline variant. Must never return a value that equals another curve set's key. */
    _key(run: GlyphRun): TextGroupKey;
    /** @internal Extra style float, packed verbatim into `TextStyle.params.y`. */
    _param(run: GlyphRun): number;
}

/** @internal */ export let _textStyleSeam: TextStyleSeam | null;
/** @internal */ export function _installTextStyleSeam(seam: TextStyleSeam): void;
```

`text-data.ts` attaches **no** feature meaning to these hooks: `_prepare` is called before
group-key evaluation with the current data/run pair, `_param` is a float copied into
`params.y`, and `_key` is a token compared with `===`. With the seam null, preparation is a
single skipped optional call and the key/parameter retain their neutral defaults. All
font-weight semantics live in `set-font-weight-offset.ts`.

`text-data.ts` additionally exports one feature-agnostic helper so per-run feature setters
resolve and validate their run argument exactly as `updateTextData` does:

```typescript
/** @internal Resolve a `GlyphRun | number` reference against `data`'s live runs. `op`
 *  prefixes the thrown message. */
export function _resolveRunRef(data: TextData, ref: GlyphRun | number, op: string): GlyphRun;
```

It is used by `updateTextData`'s own index path, so the two cannot drift, and it is
tree-shaken away for consumers that import no feature setter.

### Style packing

`writeRunToSlots` calls `_param` once per run and writes the result into
`TextStyle.params.y` (previously reserved/zero; `params.x` still carries `invScale`). No
struct or stride change. The value is compared through `Math.fround` like every other style
float, so an unchanged offset does not bump `_styleVersion`.

### Draw-group keys

`TextDataDrawGroup._groupKey: TextGroupKey` replaces the pre-feature implicit "one group per
curve set" identity. Grouping, previous-group reuse across a `reset`, `addRun` lookup and
`replaceRun`'s in-place fast path all compare **that one field by identity** — the flat
`Map<TextGroupKey, GlyphRun[]>` / `Map<TextGroupKey, TextDataDrawGroup>` shape, allocation
profile and iteration order of the pre-feature code are preserved exactly (one array per
group, no nested maps, no per-curve-set array pairs). `_curveSetId` remains on the group for
atlas lookup, bind-group labelling and error messages.

- With no styling feature installed, `_groupKey === _curveSetId` for every group and the
  grouping algorithm is byte-for-byte the pre-feature one.
- `set-font-weight-offset.ts` returns `run.curveSet` for an unweighted run and an interned
  **object** token (one per `CurveSetId`, from a lazily created `Map<CurveSetId, object>`)
  for a weighted one. An object can never `===` a string, so a curve set whose id happens to
  look like another group's variant key cannot collide — the pathological `"X"` / `"X:w"`
  pair that a delimited composite string key would conflate stays in distinct groups
  (regression-tested).
- Base and weighted runs on the same curve set land in **separate** draw groups, because
  they need different pipelines. Weighted runs with **different** nonzero offsets batch into
  **one** group — the offset travels per style entry in `params.y`.
- `g._groupKey !== g._curveSetId` is exactly "this group needs the variant pipeline", so the
  draw paths need no extra per-group state.

### Weight shader fragment

`src/text/shaders/weight-shader-fragment.ts` exports one `TextShaderFragment`
(`_id: "w"`), containing **only** incremental code:

| Slot | Contribution                                                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VO` | `@location(4) @interpolate(flat) wo:f32,` — the per-instance weight offset varying.                                                                            |
| `VD` | `d.wo=0.0;` — dead-slot default.                                                                                                                                |
| `VB` | Inflates the font-space bounds by `2.5 * wo`, the miter limit, so the quad covers both the round expansion and every accepted miter apex. |
| `VA` | `out.wo=wo;`                                                                                                                                                    |
| `FI` | `@location(4) @interpolate(flat) wo:f32,`                                                                                                                      |
| `FH` | `dot2` + `dq` (exact distance to a quadratic Bézier), signed distance to a triangle, and `wdst` (the bounded nearest-contour + miter-wedge band scan). |
| `CO` | Zero-offset guard, unsigned contour distance, signed miter distance, weighted coverage, and monotone `max` finalization.                                |

### Miter metadata and preparation

The second curve texel already stores `p2` in `.xy`; base Slug leaves `.zw` unused. The
weight feature uses those two floats for a dimensionless vector from `p2` to the single
**exterior-facing** miter apex at unit offset. A zero vector means the join is concave,
smooth, open, degenerate, or exceeds the miter limit and therefore keeps the round-distance
fallback.

Preparation replays the atlas's deterministic curve layout until every requested glyph has
been reached. It is therefore linear in the atlas prefix ending at the last referenced
glyph on that atlas's first preparation, then O(1) for repeated slider changes:

1. Walk the ordered curves, joining consecutive segments whose endpoints coincide and
   wrapping a closed contour's final segment back to its first.
2. Compute the glyph's winding sign from the exact signed-area integral of all quadratic
   segments. Oppositely wound holes subtract from the outer contours, leaving the filled
   side consistent for the glyph.
3. Normalize the incoming and outgoing endpoint tangents. Keep only turns whose sign
   matches the glyph winding: these are convex on the exterior; re-entrant joins retain the
   round fallback.
4. Build the bisector of their left normals, divide by its projection onto either normal,
   then multiply by the negative winding sign so the stored vector points into the empty
   exterior for either outline orientation.
5. Reject smooth/reversing joins and vectors longer than the `2.5` miter limit.
6. Replay the atlas's existing two-texels-per-curve row packing, write the accepted vector
   into the second texel's `.zw`, and stop as soon as all requested glyphs are prepared.

All preprocessing code lives in the tree-shakable setter module. Consumers that do not
import the setter retain zero preprocessing code and never write these channels. The
feature caches prepared glyph ids in a `WeakMap` keyed by `SharedAtlas`; repeated offset
changes are therefore O(1) with respect to contour topology. New glyphs are prepared the
first time a run that references them receives a nonzero offset.

### Why the weight fragment owns its own scan

The base band walk is a *winding* query, not a *nearest-contour* query, and its two
optimizations are only sound for winding:

1. It reads exactly **one** h-band (the band containing the pixel's `y`) and one v-band.
   That is complete for a `+x` / `+y` ray cast, because a ray from the pixel stays inside
   its own band. It is **not** complete for distance: the nearest contour to a pixel near a
   band boundary is frequently in the adjacent band.
2. Inside a band it `break`s as soon as a curve's `max x` is more than half a pixel behind
   the pixel (curves are sorted by descending `max x`). Every remaining curve is behind the
   ray, so it cannot cross it — but curves to the *left* of the pixel are exactly the ones
   that can be nearest to it.

Accumulating a running minimum distance inside those loops therefore silently skips curves
left of and below the pixel, which clips positive (emboldening) offsets on the right and
top edges of a glyph and on all four corners. The weight fragment consequently declares its
own complete, bounded scan in `FH` and reads nothing from the base loops:

```wgsl
fn wdst(rc:vec2<f32>,gp:vec2<i32>,bm:vec2<i32>,bn:vec4<f32>,rad:f32,wo:f32)->WD
```

- **Search radius.** `rad = 2.5 * wo + 1/aaScale` font units, where
  `aaScale = max(pe.x, pe.y)` is pixels-per-font-unit. The factor is the miter limit: every
  accepted apex lies within `2.5 * wo` of its endpoint. Beyond that radius both round and
  miter coverage saturate to 0 (outside) or are dominated by base coverage (inside), so a
  curve farther than `rad` cannot change the result.
- **Complete band range.** Every h-band spans the full glyph width in `x` and partitions
  `y` (`glyph-storage.ts` → `buildBandsInternal`), and a band holds every curve whose
  `y`-extent intersects it. `wdst` therefore iterates **all** h-bands intersecting
  `[rc.y - rad, rc.y + rad]`:
  `y0 = clamp(i32((rc.y - rad) * bn.y + bn.w), 0, bm.y)`,
  `y1 = clamp(i32((rc.y + rad) * bn.y + bn.w), 0, bm.y)`.
  Any curve with a point within `rad` of the pixel has that point inside the glyph's
  `y`-bounds, so its band index is inside `[y0, y1]` and the curve is in that band's list.
  *Validated band-transform invariant:* `bandScaleY = hBandCount / heightFu` when
  `heightFu > 0` and `0` otherwise, and `bandOffsetY = -yMin * bandScaleY`, so the transform
  is monotone non-decreasing and never negative. A zero scale collapses the range to band 0,
  which is the only band a zero-height glyph has. No sign guard is required; a unit test
  pins the invariant in the builder.
- **Radius-aware break only.** Within a band the scan still exploits the descending-`max x`
  sort, but with the radius-aware bound `curveMaxX < rc.x - rad`. A curve with a point
  within `rad` has `maxX >= rc.x - rad`, and every curve before it in sort order has a
  `maxX` at least as large, so no in-range curve is ever skipped.
- `dq` is the exact point-to-quadratic distance: a degenerate straight-segment fast path
  when `dot(b,b) < 1e-7`, otherwise the closest-point depressed-cubic solve with `t` clamped
  to `[0,1]` (Cardano for one real root, trigonometric form for three).

### Shader math (the `CO` slot)

```wgsl
if(in.wo!=0.0){
  let aas=max(max(pe.x,pe.y),1.0e-8);
  let wd=wdst(rc,gp,bm,in.bn,2.5*in.wo+1.0/aas,in.wo);
  let wc=clamp((in.wo-wd.d)*aas+0.5,0.0,1.0);
  let mc=clamp(0.5-wd.m*aas,0.0,1.0);
  cov=max(cov,max(wc,mc));
}
```

1. **Zero-offset guard.** A run whose offset is zero — including a stale style entry left in
   a variant group — takes no distance scan at all and keeps the base coverage bit-exactly.
2. **Base Slug coverage runs unchanged** and remains authoritative inside the original fill.
3. **Unsigned contour distance.** Positive-only emboldening needs no inside/outside
   classification: `wdst.d` is the distance to the nearest outline in either direction.
4. **Offset threshold.** Coverage decreases with distance, and the offset pushes
   the boundary outward: `wc = saturate((wo - wd.d) * aaScale + 0.5)`, a ~1px screen-space
   transition.
5. **Miter wedge.** For each nonzero `.zw` vector, the scan orients the current endpoint
   normal toward that stored exterior apex and reflects it across the bisector to recover
   the adjoining normal. Signed distance to the single resulting triangle produces `wd.m`;
   `mc = saturate(0.5 - wd.m * aaScale)` supplies anti-aliased sharp convex corners while
   concave and CPU-rejected joins retain round expansion.
6. **Monotone finalization.** Emboldening may only add coverage:
   `cov = max(cov, max(wc, mc))`. This keeps the analytic base coverage authoritative inside the
   original fill, while the distance field contributes only its outward expansion. An
   overestimated `wdst` can never punch holes into the original glyph.
7. The template then applies the coverage gamma and the `a2c` premultiply select exactly as
   for the base variant.

`aaScale` is floored at `1e-8` so a degenerate derivative (`fwidth == inf`) cannot produce a
non-finite radius; the coverage transfer function is unaffected for any real glyph.

### Limits

Offsets are clamped to `[0, 100]` font design units; out-of-range values are clamped with a
`console.warn`, and non-finite values are rejected with a `console.error`. The proportional
effect depends on the font's `unitsPerEm`: for a 2048-unit font, `100` is about `0.049 em`.
The bound exists because large offsets expand the glyph quad into its neighbours and
lengthen the per-pixel band scan (its cost is proportional to the number of bands the
radius spans). Miter joins use a fixed `2.5` limit: common right-angle corners and Inter's Q
tail (about `2.25 * offset`) remain sharp, while more acute joins fall back to the existing
round expansion instead of producing long spikes or forcing larger quads.

### Test specification

`tests/lite/unit/text-font-weight-offset.test.ts`:

- **Setter semantics** — attach / overwrite / clear-with-zero on a live `TextData`; `NaN`
  and `Infinity` rejected with `console.error` and no repack; values clamped to `[0, 100]` with
  `console.warn`; setting the value a run already has is a no-op (`_version` and
  `_layoutVersion` unchanged), and a zero call on a never-weighted run installs nothing.
- **Miter preparation** — the curve texel `.zw` channels start at zero; the first effective
  positive call writes the expected unit miter vectors only for referenced glyphs and bumps
  the atlas version once; repeated calls and additional weighted runs referencing an
  already-prepared glyph do not rewrite or re-version the atlas. An L-shaped fixture proves
  the convex joins point toward the exterior while its re-entrant join stays zero. An open
  glyph with no accepted joins proves no atlas version/upload churn, and swapping storage
  under an already-weighted run prepares the replacement atlas during reset.
- **Run resolution** — the index form (`setFontWeightOffset(data, 0, …)`) is equivalent to
  the reference form; an out-of-range index and a `GlyphRun` that belongs to another
  `TextData` both throw with the `updateTextData`-shaped message.
- **Post-create mutation** — a setter call made *after* `createTextData` (i.e. after the
  runs are already packed) changes the run's draw-group key and its `params.y` immediately;
  a following zero restores both to the base key and `0`.
- **Style packing** — a weighted run's `params.y` holds `Math.fround(offset)`; a base run's
  is `0`.
- **`DefaultTextData` flow** — the setter works on `data.runs[0]` immediately after
  `createDefaultTextData`, and after `updateDefaultTextData` replaces the run the offset
  does not transfer but re-applying it by index does.
- **Variant grouping** — one base + one weighted run on the same curve set produce two groups
  with the same `_curveSetId`, one keyed by the curve set and one by an interned token; two
  weighted runs with different offsets share one group; `addRun` / `replaceRun` / `removeRun`
  respect the key.
- **Group-key collision regression** — the `"X:w"` / `"X"` pair stays in distinct groups with
  the correct curve set, on create and across a `reset` (group object identity is reused per
  key).
- **Band-scan completeness (algorithmic)** — a JS replica of `wdst`'s candidate selection,
  driven by the real `buildGlyphBands` output for a synthetic square glyph, must consider the
  true nearest curve for sample points on all four exterior sides and all four corners. The
  pre-fix "accumulate inside the base loop" candidate set is asserted to *fail* the same
  check, so the regression cannot silently return.
- **Band-transform invariant** — `buildGlyphBands` + the packed metadata always produce a
  non-negative, monotone band transform (what `wdst`'s range clamp relies on).
- **Composition** — `composeSlugShader(null)` contains no weight varying, `dq`/`wdst` helper
  or coverage override, and its band loops contain no injected statements; the composed
  variant contains all of them; the base source is a subsequence of the variant at every
  significant line, proving composition rather than duplication. `_key` is `""` for the base
  and the fragment id for the variant.
- **Coverage direction** — a JS replica of the `CO` transfer function proves positive offsets
  expand, miter triangles add their sharp wedge, and `max` finalization can never remove
  analytic base coverage.
- **Pipeline cache key** — the exported key builder is fixed arity and a base A2C pipeline
  cannot collide with a variant whose id is `"a"`.

`tests/lite/unit/text-renderer-variant-pipeline.test.ts`: a mocked device + render-bundle
encoder records a layer holding base, weighted and base draw groups and asserts the exact
`setPipeline` / `setBindGroup` / `draw` command sequence (base → variant → base), that a
base-only layer records exactly the pre-feature command sequence, and that the variant
pipeline is resolved during `_update`, not per draw. The same file covers the
`TextRenderable` late-install path in module isolation (`vi.resetModules()` + dynamic
import, so no earlier test has installed the resolver): a renderable is **bound first**,
its binding `update` runs with no styling feature installed (variant pipeline aliases the
base), the setter is then called on its live `TextData`, and the next binding `update`
must refresh `gpu._variantPipeline` to a distinct pipeline built from the same target
signature — after which the recorded draw sequence is base → variant → base.

`tests/lite/build/text-shader-fragment-treeshake.test.ts` (Rollup over the shipped
`build/lib`): a consumer importing text rendering but not `setFontWeightOffset` retains the
base Slug source and **not** the weight fragment's WGSL; a text consumer that also imports
`setFontWeightOffset` retains both, with the base Slug logic still declared exactly once.
