# Module: Texture region uploads

> Package path: `packages/babylon-lite/src/texture/texture-region.ts`

## Purpose

Write CPU data in an allocation's own copyable format into a mip/array-layer box. Validate
destination block geometry and the entire source footprint, including the final row, before
queueing the upload. Reuse descriptors and the caller's source buffer without allocating a new view.

## Public API Surface

```typescript
export interface TextureRegion {
    x?: number;
    y?: number;
    layer?: number;
    mipLevel?: number;
    width: number;
    height: number;
    layerCount?: number;
    bytesPerRow: number;
    rowsPerImage?: number;
    dataOffset?: number;
}

export function updateTextureRegion(
    engine: EngineContext,
    texture: Texture2D,
    data: ArrayBufferView,
    region: TextureRegion
): void;
```

Origins, mip, and data offset default to zero; layer count defaults to one. Width and height
are destination texels, including complete compressed edge blocks. `bytesPerRow` is the source
byte stride. `rowsPerImage` counts **block rows**, defaulting to `height / blockH`.
`dataOffset` is relative to the supplied view, not its backing buffer. Any byte offset and
stride satisfying the footprint are allowed: `queue.writeTexture` requires neither texel-byte
alignment nor 256-byte alignment.

The destination must be single-sampled and have copy-destination usage. No mip generation,
format conversion, or UV flip occurs. Caller-owned region state may be mutated and reused.

## Internal Architecture

`compressed-formats.ts` additionally owns an internal GPU-format block lookup:

```typescript
export function getTextureFormatBlockInfo(
    format: GPUTextureFormat
): Pick<CompressedFormatInfo, "blockW" | "blockH" | "blockBytes"> | undefined;
```

Its lazy string-keyed map reuses existing compressed-format records, including every ASTC block
shape. BC1/2/3 sRGB keys alias their linear records. Uncompressed records have `blockW = blockH = 1`
and shared records for these byte footprints:

| Bytes | Formats |
|-------|---------|
| 1 | r8unorm, r8snorm, r8uint, r8sint, stencil8 |
| 2 | r16unorm, r16snorm, r16uint, r16sint, r16float, rg8unorm, rg8snorm, rg8uint, rg8sint, depth16unorm |
| 4 | r32uint, r32sint, r32float, rg16unorm, rg16snorm, rg16uint, rg16sint, rg16float, rgba8unorm, rgba8unorm-srgb, rgba8snorm, rgba8uint, rgba8sint, bgra8unorm, bgra8unorm-srgb, rgb9e5ufloat, rgb10a2uint, rgb10a2unorm, rg11b10ufloat |
| 8 | rg32uint, rg32sint, rg32float, rgba16unorm, rgba16snorm, rgba16uint, rgba16sint, rgba16float |
| 16 | rgba32uint, rgba32sint, rgba32float |

Depth32 float CPU writes are disallowed; depth24plus has an opaque depth representation.
Combined formats need an explicit single aspect that this API does not expose. None has a
lookup record, so these uploads throw rather than guessing a footprint. Depth16/stencil-only
uploads must cover each selected layer's full physical mip width and height. A subset of array
layers is allowed: layers are distinct subresources, not another spatial extent of a 2D subresource.

Compute physical mip width/height by rounding the logical dimensions up to `blockW` / `blockH`.
Array layers do not shrink with mip level; a 3D allocation's depth does.
Validate integer mip, extent, origin, layer range, source offset, and unsigned-32-bit row/image
strides. Extents and x/y origins must be block multiples.

Let `blockRows = height / blockH` and `lastRowBytes = width / blockW * blockBytes`.
Require `bytesPerRow >= lastRowBytes` and `rowsPerImage >= blockRows`. The exact required source
length is:

```text
bytesPerRow * (rowsPerImage * (layerCount - 1) + blockRows - 1) + lastRowBytes
```

Require a safe-integer result and `dataOffset + requiredBytes <= data.byteLength`.
Padding after the last row is unnecessary; data beyond the view's end never satisfies validation.

Three module-local nullable descriptors are initialized lazily: destination
`{texture, mipLevel, origin:{x,y,z}}`, layout `{offset, bytesPerRow, rowsPerImage}`, and extent
`{width,height,depthOrArrayLayers}`. Rewrite their scalar fields for each call.
Pass `data.buffer` with `offset = data.byteOffset + dataOffset`; WebGPU snapshots the descriptors
synchronously. Metadata contains no GPU handles and remains valid across device replacement.

## Pipeline Configuration

None. The queue upload precedes subsequently submitted rendering work.

## Shader Logic

None. CPU bytes already encode the destination format; no WGSL inspection or conversion occurs.

## State Machine / Lifecycle

1. Validate usage, sampling, copy format, destination geometry, and source footprint.
2. Lazily obtain/reuse descriptors.
3. Queue one write using the caller's backing buffer.

An invalid request throws before any queue write. The module does not acquire or release textures,
retain source data, or manage device recovery.

## Babylon.js Equivalence Map

Equivalent to raw texture-region updates with explicit source strides and selected layers/mips.
Lite exposes allocation-format bytes rather than an RGBA8-only pixel conversion API.

## Dependencies

Engine and texture facades are type-only imports. `engine/gpu-flags.ts` supplies copy usage.
`texture/compressed-formats.ts` owns block metadata instead of duplicating compressed format tables.
The root index exports `TextureRegion` and `updateTextureRegion`, not the internal metadata lookup.

## Test Specification

`tests/lite/unit/texture-render-target.test.ts` covers exact final-row fits and one-byte shortages,
view-versus-buffer bounds, multi-layer row padding, undersized strides, legal odd offsets/strides,
non-finite/fractional/out-of-range numbers, compressed block origins/extents, physical edge mips,
block-row defaults, format footprints, full-width/height depth/stencil copies into selected array
layers, 3D mip-depth bounds, unsupported aspects, copy usage/sample count, and unchanged
descriptor identity. Existing RGBA16 and R32 upload contracts remain covered.

## File Manifest

- `texture/texture-region.ts`: destination/layout validation and queue upload.
- `texture/compressed-formats.ts`: shared lazy GPU-format block metadata.
- `tests/lite/unit/texture-render-target.test.ts`: upload regression cases.
