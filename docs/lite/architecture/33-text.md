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
export interface GlyphStorage { /* opaque */ }
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
    readonly x: number;  // pixels, glyph origin
    readonly y: number;  // pixels, baseline up
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
    readonly opacity?: number;       // whole-block fade. default 1
    readonly ignoreDepth?: boolean;  // skip depth test/write. default false
    readonly order?: number;         // sort order. default 200
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

### Tier 3b — `TextRenderer` + `TextLayer` (standalone 2D)

```typescript
export interface TextLayerOptions {
    readonly positionPx?: { x: number; y: number };  // canvas pixel origin
    readonly rotationRad?: number;                   // z-axis rotation
    readonly scale?: number;                         // uniform
    readonly order?: number;                         // within renderer
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
    clear?: boolean;                                 // default true
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
export interface Font { /* opaque, wraps text-shaper.Font */ }
export function loadFont(url: string): Promise<Font>;
export function createFontFromBuffer(data: ArrayBuffer): Font;

export function extractGlyphCurves(font: Font, glyphIds: ReadonlySet<number>, target: Map<number, GlyphCurves>): void;
export function cubicToQuadratics(/* control points */): [QuadCurve, QuadCurve];

export interface DefaultTextData extends TextData {
    readonly width: number;   // pixel-space laid-out width
    readonly height: number;  // pixel-space laid-out height
}
export function createDefaultTextData(
    font: Font, fontSizePx: number, text: string,
    textColor?: [number, number, number, number], options?: TextLayoutOptions
): DefaultTextData;
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
import {
    createEngine, startEngine,
    loadFont,
    createDefaultTextData,
    createTextLayer,
    createTextRenderer, registerTextRenderer,
} from "@babylonjs/lite";

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
    curveTexData: Float32Array;   // rgba32float, width 4096, grows by row doubling
    curveTexelsUsed: number;
    bandTexData: Float32Array;    // rgba32float, width 4096, grows by row doubling
    bandTexelsUsed: number;
    glyphSlots: Map<number, AtlasSlot>;  // glyphId → curve start + band header location + band counts
    version: number;              // monotonic, bumped per packAppendGlyph
    gpu: SharedAtlasGpu | null;   // lazy
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
    curveSetId: CurveSetId;
    curveSet: GlyphStorageCurveSet;  // cached pointer into _storage._curveSets
    slotStart: number;
    slotCount: number;     // live + dead
    liveCount: number;
    freeSlots: number[];   // LIFO stack of dead slot indices
    bindGroup: GPUBindGroup | null;
    bindGroupVersion: number;  // last-seen atlas.uploadedVersion
};
```

One draw group per unique `curveSetId` used by the live runs. Each group owns a
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

One bind group layout + one pair of WGSL modules cached per `GPUDevice` (a
`WeakMap<GPUDevice, TextPipelineDeviceCache>`). The render pipeline itself is
cached per `(colorFormat, sampleCount, depthStencilFormat, depthWrite, flipY)`
key — so a `TextRenderable` with `ignoreDepth=true` and a `TextRenderable`
with `ignoreDepth=false` share modules + bind group layout but get separate
pipelines.

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

The vertex stage (`shaders/slug.vert.wgsl`):

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

The fragment stage (`shaders/slug.frag.wgsl`):

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

`draw` then iterates the draw groups: `setBindGroup(0, g.bindGroup)`;
`pass.draw(6, g.slotCount, 0, g.slotStart)`. There is one draw call per
non-empty group, and `slotCount` includes dead slots (which collapse in the
vertex shader). Crucially, `TextRenderable` does **not** bind the scene's
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
| `src/text/_gpu/text-pipeline.ts`  | `getOrCreateTextPipeline` / `clearTextPipelineCache`; per-device bind group layout + WGSL modules + per-target-key pipeline cache.                                                                                                                                                                                     |
| `src/text/shaders/slug.vert.wgsl` | Vertex stage: dead-slot collapse + Slug dilation + MVP transform.                                                                                                                                                                                                                                                      |
| `src/text/shaders/slug.frag.wgsl` | Fragment stage: per-band quadratic root solve + signed coverage accumulation.                                                                                                                                                                                                                                          |
