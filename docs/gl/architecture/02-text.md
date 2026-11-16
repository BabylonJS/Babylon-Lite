# Module: Lite-GL Text (Slug)

> Package path: `packages/babylon-lite-gl/src/text/`
>
> WebGL2 counterpart of Lite's standalone `TextRenderer` (`packages/babylon-lite/src/text/`, documented in
> `docs/lite/architecture/33-text.md`). Same Slug algorithm, same CPU layout and the same atlas format; only
> the GPU plumbing differs.

## Purpose

Draw resolution-independent glyphs on a WebGL2 canvas or render target without a scene or camera. Glyph
outlines are stored as quadratic Béziers with a spatial-band index; the fragment shader resolves analytic
coverage per pixel (Eric Lengyel's Slug algorithm), so text stays sharp at any scale or rotation.

## Public API Surface

All symbols are explicit root exports of `@babylonjs/lite-gl`; nothing is added to the engine context, so
unused text code tree-shakes away.

```typescript
// Fonts (text-shaper behind an opaque handle)
loadFont(url: string): Promise<GLFont>;
createFontFromBuffer(data: ArrayBuffer): GLFont;

// One-call shaping + curve extraction + packing
createDefaultTextData(font, fontSizePx, text, textColor?, layoutOptions?): GLDefaultTextData;
updateDefaultTextData(data, text, textColor?): void;
disposeDefaultTextData(data): void;

// Bring-your-own layout
createGlyphStorage(initial?): GLGlyphStorage;
updateGlyphStorage(storage, curveSetId, curves): void;
disposeGlyphStorage(storage): void;
createTextData(storage, runs?): GLTextData;
updateTextData(data, update: GLTextDataUpdate): void; // discriminated by `update.update`
disposeTextData(data): void;
extractGlyphCurves(font, glyphIds: ReadonlySet<number>, target: Map<number, GLGlyphCurves>): void;

// Drawing
createTextLayer(data, options?): GLTextLayer; // pixel-space position / rotation / scale / opacity / order
setTextLayerPosition(layer, x, y): void;
createTextRenderer(engine, { layers, clear?, clearValue? }): GLTextRenderer;
isTextRendererReady(renderer): boolean;
renderText(renderer): number; // draw calls issued
registerTextRenderer(renderer): void; // installs one render-loop callback (idempotent)
unregisterTextRenderer(renderer): void;
addTextRendererLayer(renderer, layer): void;
removeTextRendererLayer(renderer, layer): boolean;
disposeTextRenderer(renderer): void;

// Optional synthetic weight (own module and shader; bundled only when imported)
setFontWeightOffset(data, run | index, offset): void;
```

Ownership follows the WebGPU module: layers and renderers borrow `GLTextData`, and `GLTextData` borrows its
`GLGlyphStorage`. `createDefaultTextData` is the exception that bundles its storage; release both with
`disposeDefaultTextData`. A glyph storage's GPU resources belong to the first engine that draws it, and a
second engine throws.

## Internal Architecture

- **Atlas.** `glyph-storage.ts` and `_gpu/text-textures.ts` hold the same layout as WebGPU: a 4096-wide
  `RGBA32F` curve texture and an `RG32UI` band texture whose rows grow with the data. Band headers and
  curve-reference lists are `Uint32Array` texels read with `texelFetch` on a `usampler2D` (no float
  rounding). Band blocks never straddle a row, and the shader wraps list reads into the next row.
- **Lookup textures.** WebGL2 has no storage buffers, so per-glyph metadata and the style palette are
  256-wide `RGBA32F` lookup textures (`TABLE_WIDTH`), fetched in the vertex shader by flat offset.
- **Draw.** One instanced draw per draw group: a shared six-vertex quad plus a per-group instance VAO
  (`_gpu/text-vao.ts`) over the text data's instance buffer. Blending is premultiplied source-over with no
  depth test; the shader premultiplies RGB by `color.a * coverage`.
- **Variants.** Programs are built through `_gpu/text-effect.ts` and the standard effect cache. The base
  program is created with the renderer. A styled-variant program (synthetic weight) is created lazily when
  a visible layer has weighted groups, so `isTextRendererReady` stays false until it links.
- **Context loss.** Textures use `createRawTexture` / `updateRawTexture`, so their restore uploads come from
  the engine's texture registry. The renderer drops its VAO cache on context loss and rebuilds on demand.

## Differences from the WebGPU module

| Topic             | WebGPU                        | WebGL2                                       |
| ----------------- | ----------------------------- | -------------------------------------------- |
| Glyph metadata    | storage buffer                | `RGBA32F` lookup texture                     |
| Style palette     | storage buffer                | `RGBA32F` lookup texture                     |
| Band atlas        | `rg32uint`, `texture_2d<u32>` | `RG32UI`, `usampler2D`                       |
| Scene text        | `TextRenderable` (3D, depth)  | not provided (pure 2D `GLTextRenderer` only) |
| Alpha-to-coverage | pipeline-overridable `a2c`    | not provided                                 |

## Test Specification

`tests/gl/unit/text-renderer.test.ts` covers render-loop registration; `tests/gl/unit/text-atlas.test.ts`
covers the `Uint32Array` band staging and row wrapping, `RG32UI` / `RGBA32F` uploads, size limits, the
one-engine rule and the integer band reads in the shader. Pixel-level coverage is exercised through the
WebGPU text scenes, which share the algorithm.

## File Manifest

| File                                         | Role                                                         |
| -------------------------------------------- | ------------------------------------------------------------ |
| `src/text/font.ts`                           | `GLFont`, `loadFont`, `createFontFromBuffer`                 |
| `src/text/layout.ts`                         | default shaping/layout through `text-shaper`                 |
| `src/text/glyph-extraction.ts`               | glyph outlines to quadratic curves                           |
| `src/text/glyph-storage.ts`                  | `GLGlyphStorage`, `SharedAtlas`, curve and band packing      |
| `src/text/text-data.ts`                      | `GLTextData` slot allocator and instance buffer              |
| `src/text/default-text-data.ts`              | one-call shaping + packing                                   |
| `src/text/text-renderer.ts`                  | layers, renderer, render-loop registration                   |
| `src/text/set-font-weight-offset.ts`         | synthetic weight (optional module; bundled only if imported) |
| `src/text/_gpu/text-textures.ts`             | atlas, metadata and style textures                           |
| `src/text/_gpu/text-instances.ts`            | per-instance vertex buffer                                   |
| `src/text/_gpu/text-vao.ts`                  | per-group instance VAOs                                      |
| `src/text/_gpu/text-effect.ts`               | Slug program creation and uniforms                           |
| `src/text/shaders/slug-shader.ts`            | GLSL ES 3.00 Slug vertex and fragment shaders                |
| `src/text/shaders/weight-shader-fragment.ts` | synthetic-weight shader fragment                             |
| `src/text/shaders/text-shader-fragment.ts`   | shader fragment slot types                                   |
