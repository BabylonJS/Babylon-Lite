# Module: Texture pixel readback

> Package path: `packages/babylon-lite/src/texture/texture-pixel-readback.ts`

## Purpose

Optional, read-only texture inspection for previews and PNG export. Existing factory usage flags,
application rendering, resource references and source texture contents are unchanged. Importing the
root package without using these functions must eliminate the whole readback implementation.

## Public API Surface

```ts
interface TextureReadbackInfo {
    kind: "2d" | "cube" | "2d-array" | "3d";
    width: number;
    height: number;
    depthOrArrayLayers: number;
    mipLevelCount: number;
}
interface TextureReadbackOptions {
    mipLevel?: number;
    face?: number;
    layer?: number;
    slice?: number;
    flipY?: boolean;
}
interface TextureReadbackResult {
    pixels: Uint8Array<ArrayBuffer>;
    width: number;
    height: number;
}
function getTextureReadbackInfo(texture: Texture2D | CubeTexture): TextureReadbackInfo;
function readTexturePixelsRGBA8(engine: EngineContext, texture: Texture2D | CubeTexture, options?: TextureReadbackOptions): Promise<TextureReadbackResult>;
```

`Texture2DArray` and `Texture3D` are already assignable to `Texture2D`. Cube dimensions are
queried internally without exposing its opaque native handle. Metadata describes the underlying
allocation, not a potentially stale wrapper size or a wrapper's restricted view.

Selections default to zero. Faces use WebGPU cube order: +X, -X, +Y, -Y, +Z, -Z.
Only the selector appropriate to the texture kind is accepted, even when another selector is zero.
Mip levels and selectors must be finite nonnegative integers within the selected subresource.
Array layer count does not shrink with mip level; 3D slice count does. Sizes at mip `m`
are `max(1, floor(baseSize / 2**m))`.

Output is tightly packed row-major RGBA8, with GPU storage row zero first. `flipY` reverses
rows explicitly. No implicit interpretation of `invertY`, UV transforms, cube projection,
or material state occurs. Callers decide the presentation orientation.

Sampleable floating-point, normalized and compressed color formats are converted to RGBA8.
Values clamp to [0,1] and quantize to 8 bits. Missing RGB channels are zero and missing alpha
is one, following WebGPU texture-load rules. For sRGB inputs, hardware decode and encode
preserve the source RGB transfer encoding; linear formats stay linear. There is no tone
mapping, exposure, gamma conversion of linear inputs, or alpha unpremultiplication.
An HDR/linear image may therefore require a separate display transform in the caller.
NaN and infinity in floating-point source data have no portable RGBA8 conversion guarantee.

Depth/stencil, integer, multisampled, non-sampleable, and non-2D/3D allocations reject explicitly.
WebGPU validation errors (including destroyed textures and textures owned by another device),
allocation errors, device loss and map failures reject instead of producing successful blank pixels.
Metadata alone does not establish that an allocation is live/readable.

## Internal Architecture

The public implementation imports wrapper and engine types only, plus GPU flag aliases and the
existing internal RGBA8 staging-copy helper (`read-texture-pixels.ts`). No factory changes,
registries, cached pipelines, or module-level allocations are needed.

Resolve the native texture from `Texture2D.texture` or `CubeTexture._texture`. Determine kind
from the cube wrapper, native `dimension`, and the array wrapper's `layers` property (also
recognize native allocations with more than one 2D layer). Validate before allocating resources.
Never use the application sampler or view: create a dedicated single-mip, single-layer 2D view
for 2D/array/cube inputs and a single-mip 3D view for volumes.

## Pipeline Configuration

One fullscreen triangle, no vertex buffer, default no culling, no depth/stencil, no blending.
An explicit fragment-visible binding of sample type `unfilterable-float` accepts both
filterable and unfilterable color formats without requesting float filtering features.
Bind group zero contains just the source texture view. No sampler or uniforms are needed:
the selected 3D slice is a validated integer embedded in the shader.
The output attachment is `rgba8unorm-srgb` for sRGB sources, otherwise `rgba8unorm`, with
`RENDER_ATTACHMENT | COPY_SRC` usage. It has the selected mip's width and height.

## Shader Logic

Vertex index generates positions (-1,-1), (3,-1), (-1,3).
Fragment coordinates are converted directly to integer pixel coordinates.
`textureLoad(source, xy, 0)` or `textureLoad(source, vec3(xy, slice), 0)` reads exactly one texel
without filtering, resizing or dependence on the original sampler. The mip is zero relative
to the single-mip view. Returning the loaded color lets the output attachment perform clamp,
quantization and (when applicable) sRGB encoding.

## State Machine / Lifecycle

Each call owns its output attachment, pipeline, view, bind group and staging buffer independently.
Push validation and out-of-memory scopes, synchronously record/submit the conversion, start
the staging copy/map and pop both scopes before any await. This prevents concurrent reads
from capturing one another's error scopes. Await both scoped errors and CPU pixels.
Reject any scoped error. The staging helper unmaps/destroys its buffer in `finally`;
the public function destroys the output attachment in its own `finally`, including failures.
No retain/release or destruction of source textures occurs. A submitted application pass
precedes the readback; unsubmitted application commands are not flushed by this API.
Call after the application's frame submission when that frame's contents are required.

## Babylon.js Equivalence Map

Supplies the pixel acquisition part of Inspector texture preview/export, with explicit
face/layer/slice/mip selectors. PNG encoding and canvas/display transforms belong to the UI,
not the engine API. Unlike general BJS texture reads, this contract always returns RGBA8.

## Dependencies

Type-only: `EngineContext`, `Texture2D`, `CubeTexture`.
Runtime: GPU flag constants and the existing staging-copy helper. WebGPU only.

## Test Specification

Unit tests cover metadata for every kind, selection validation, mip dimensions, view
descriptors, shader/pipeline configuration, sRGB versus linear attachment formats, padding
removal, explicit row reversal, unsupported formats/usages, scope errors, mapping failure,
cleanup and independent concurrent calls. Build tests compile a consumer against emitted
root declarations and prove unused readback is eliminated. Non-visual browser GPU tests
verify exact bytes, face/layer/slice/mip selection and source preservation.

## File Manifest

- `packages/babylon-lite/src/texture/texture-pixel-readback.ts`: public API and conversion.
- `packages/babylon-lite/src/texture/read-texture-pixels.ts`: existing private staging copy.
- `packages/babylon-lite/src/index.ts`: root value/type exports.
- `tests/lite/unit/texture-pixel-readback.test.ts`: scoped unit coverage.
- `tests/lite/build/texture-pixel-readback.test.ts`: tree-shaking and emitted API coverage.
- `tests/lite/build/public-api-types.test.ts`: emitted root API type probe.
- `tests/lite/integration/texture-pixel-readback.spec.ts`: non-visual browser GPU checks,
  selected by `config/playwright.integration-cloud.config.ts`.
- This document: standalone specification.
