# Module: Texture2DArray

> Package path: `packages/babylon-lite/src/texture/texture-array.ts`

## Purpose

Provides tree-shakeable WebGPU 2D texture-array creation and upload helpers for image sources, raw RGBA8 pixels, one multi-layer KTX2 container, or an ordered non-empty list of separate single-layer KTX2 files.

`Texture2DArray` is sampled by custom shaders as `texture_2d_array<f32>`. Built-in Standard and PBR material texture slots remain two-dimensional and do not accept array-layer selection.

## Public API Surface

```typescript
export interface Texture2DArray extends Texture2D {
    layers: number;
}

export interface TextureArrayOptions {
    mipMaps?: boolean;
    srgb?: boolean;
    addressModeU?: GPUAddressMode;
    addressModeV?: GPUAddressMode;
    minFilter?: GPUFilterMode;
    magFilter?: GPUFilterMode;
}

export interface ArrayLayerUploadOptions {
    invertY?: boolean;
    premultiplyAlpha?: boolean;
}

export interface TextureArrayFromUrlsOptions extends TextureArrayOptions, ArrayLayerUploadOptions {}

export function createTexture2DArray(
    engine: EngineContext,
    width: number,
    height: number,
    layers: number,
    options?: TextureArrayOptions
): Texture2DArray;

export function uploadImageToArrayLayer(
    engine: EngineContext,
    tex: Texture2DArray,
    layer: number,
    source: GPUCopyExternalImageSource,
    opts?: ArrayLayerUploadOptions
): void;

export function loadImageToArrayLayer(
    engine: EngineContext,
    tex: Texture2DArray,
    layer: number,
    url: string,
    opts?: ArrayLayerUploadOptions
): Promise<void>;

export function createTexture2DArrayFromUrls(
    engine: EngineContext,
    urls: readonly [string, ...string[]],
    options?: TextureArrayFromUrlsOptions
): Promise<Texture2DArray>;

export function createTexture2DArrayFromPixels(
    engine: EngineContext,
    data: Uint8Array,
    width: number,
    height: number,
    layers: number,
    options?: TextureArrayOptions
): Texture2DArray;

export function updateTexture2DArrayFromPixels(
    engine: EngineContext,
    tex: Texture2DArray,
    data: Uint8Array,
    mipLevel?: number
): void;

export function uploadKtx2Texture2DArray(
    engine: EngineContext,
    buffer: ArrayBuffer,
    sRGB?: boolean
): Promise<Texture2DArray>;

export function uploadKtx2Texture2DArrayFromBuffers(
    engine: EngineContext,
    buffers: readonly [ArrayBuffer | ArrayBufferView, ...(ArrayBuffer | ArrayBufferView)[]],
    sRGB?: boolean
): Promise<Texture2DArray>;

export function loadKtx2Texture2DArray(
    engine: EngineContext,
    url: string,
    sRGB?: boolean
): Promise<Texture2DArray>;

export function loadKtx2Texture2DArrayFromUrls(
    engine: EngineContext,
    urls: readonly [string, ...string[]],
    sRGB?: boolean
): Promise<Texture2DArray>;
```

The package also retains this compatibility-oriented API in `texture/ktx2-texture-array.ts`:

```typescript
export interface Ktx2TextureArrayOptions {
    generateMipMaps?: boolean;
    srgb?: boolean;
    invertY?: boolean;
    minFilter?: GPUFilterMode;
    magFilter?: GPUFilterMode;
    mipmapFilter?: GPUMipmapFilterMode;
}

export function createTexture2DArrayFromKtx2(
    engine: EngineContext,
    buffer: ArrayBuffer | ArrayBufferView,
    options?: Ktx2TextureArrayOptions
): Promise<Texture2DArray>;
```

Use `createTexture2DArrayFromKtx2` when Babylon.js compatibility or its sampler/mipmap options are required. It forces RGBA8 output, uploads only the authored base level, and optionally regenerates mipmaps. Use `uploadKtx2Texture2DArray` / `loadKtx2Texture2DArray` for the native Lite path: it preserves the decoder-selected GPU-compressed format and uploads the complete authored mip chain. The `FromBuffers` / `FromUrls` variants apply that same native contract to separate single-layer files in caller-provided layer order.

## Internal Architecture

The KTX2 path converts decoder output into one validated upload plan before creating GPU resources:

```typescript
interface Ktx2ArrayUploadPlanBase {
    layers: number;
    levels: Ktx2DecodedMip[][]; // [mip level][array layer]
    width: number;
    height: number;
    gpuFormat: GPUTextureFormat;
}

interface CompressedKtx2ArrayUploadPlan extends Ktx2ArrayUploadPlanBase {
    kind: "compressed";
    info: CompressedFormatInfo;
}

interface UncompressedKtx2ArrayUploadPlan extends Ktx2ArrayUploadPlanBase {
    kind: "uncompressed";
    bytesPerPixel: number;
}

type Ktx2ArrayUploadPlan = CompressedKtx2ArrayUploadPlan | UncompressedKtx2ArrayUploadPlan;
```

`groupArrayMips` reshapes the decoder's flat, level-major output into `[level][layer]` and verifies every `layerIndex`. `mergeSeparateKtx2Layers` validates separate files and emits the same shape, so packed and separate sources share all later validation and upload code.

Preflight validates:

- integer positive decoded and base-mip dimensions;
- exact `max(1, base >> level)` mip progression;
- device 2D-dimension, array-layer, and legal mip-count limits;
- availability of the selected ASTC, BC, or ETC2 feature;
- `texture-compression-unaligned` for a compressed base size that is not block-aligned;
- exact byte length for every compressed or uncompressed layer/mip payload.

`createEngine` requests `texture-compression-unaligned` opportunistically when the adapter offers it. Device-lost recovery captures the device's enabled feature set and requests the same feature from the replacement adapter/device.

## Pipeline Configuration

RGBA image/pixel arrays use:

```typescript
{
    dimension: "2d",
    format: srgb ? "rgba8unorm-srgb" : "rgba8unorm",
    mipLevelCount: mipMaps ? floor(log2(max(width, height))) + 1 : 1,
    usage: TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT
}
```

Their view dimension is `"2d-array"`. Image uploads use `copyExternalImageToTexture`; pixel uploads use `writeTexture`. The shared mipmap generator records one blit chain per changed layer.

KTX2 arrays use the decoder-selected compressed or uncompressed format, the authored mip count, and `TEXTURE_BINDING | COPY_DST`. They omit `RENDER_ATTACHMENT` because no mip generation occurs. Each layer/mip is written with `origin.z = layer`; compressed copy extents round up to complete compression blocks while payload validation uses the exact block count.

Samplers come from the engine sampler pool. KTX2 arrays use the shared KTX2 sampler policy; image/pixel arrays use the caller's address/filter options.

## Shader Logic

Declare the material sampler with `viewDimension: "2d-array"` and bind the returned facade with `setShaderTexture`. WGSL supplies the integer layer separately:

```wgsl
textureSampleGrad(surfaceMap, surfaceMapSampler, uv, layer, dx, dy)
```

Image uploads default to a physical Y flip. Codec-decoded KTX2 data is uploaded unflipped and returns `invertY = true`; custom shader code must apply `v = 1 - v` when honoring that metadata.

## State Machine / Lifecycle

### Empty/image/pixel arrays

1. Validate positive dimensions, layer count, layer index, mip index, and payload size.
2. Create the texture, `"2d-array"` view, and pooled sampler.
3. Acquire one logical texture ownership reference before returning.
4. Upload image/pixel data.
5. Generate mips for the affected layer after a base-level upload when mipmaps are enabled.
6. The caller eventually releases/disposes the returned texture through the shared texture ownership API.

`createTexture2DArrayFromUrls` fetches and decodes every image with `Promise.allSettled`. If any source fails, every fulfilled `ImageBitmap` is closed before the first rejection is rethrown. On success, all dimensions are validated, every bitmap is uploaded, and every bitmap is closed.

### Packed KTX2

1. Decode the buffer through `decodeKtx2Async`.
2. Group and preflight all layers and authored mips.
3. Push validation and out-of-memory error scopes.
4. Create the texture/view/sampler and upload every layer/mip.
5. Pop and await both scopes before publishing ownership.
6. Destroy the created GPU texture and rethrow the original operation, scope, or GPU error on any failure.
7. Acquire the texture only after synchronous work and asynchronous WebGPU validation both succeed.

### Separate-file KTX2

1. Reject an empty collection at runtime for untyped callers; the public tuple type rejects it statically.
2. Normalize every `ArrayBufferView` to an exact standalone `ArrayBuffer` before starting asynchronous decoding.
3. Decode all buffers concurrently.
4. Require each result to describe one layer with matching format, dimensions, and authored mip chain.
5. Merge into the packed plan shape and continue through the same preflight, allocation, upload, error-scope, and acquisition sequence.

URL loaders own only fetch/status validation and delegate to the corresponding buffer uploader.

## Babylon.js Equivalence Map

| Lite API | Babylon.js concept | Deliberate Lite behavior |
|---|---|---|
| `createTexture2DArray` / pixel and image helpers | `RawTexture2DArray` and raw array upload helpers | Direct WebGPU facade with pooled sampler and explicit ownership |
| `createTexture2DArrayFromKtx2` | Compatibility `CreateTexture2DArrayFromKTX2Async` | RGBA8/base-level path retained for compat semantics and sampler options |
| `uploadKtx2Texture2DArray` / `loadKtx2Texture2DArray` | KTX2 array decode/upload | Native WebGPU compressed upload with all authored mips |
| `FromBuffers` / `FromUrls` | Application-side separate-layer assembly | One decoder pass per source, strict equality checks, caller order defines layers |

## Dependencies

- `engine/engine.ts`: device, queue, limits, and negotiated features.
- `engine/gpu-flags.ts`: texture usage constants.
- `resource/texture-acquire.ts`: logical ownership acquisition.
- `resource/texture-sampler-pool.ts`: sampler reuse.
- `texture/ktx2-loader.ts`: decoder loading, capability selection, decoded types, sampler policy, sRGB format conversion.
- `texture/compressed-formats.ts`: compressed block geometry and required feature.
- `texture/generate-mipmaps.ts`: per-layer mip generation for image/pixel arrays.
- `texture/mip-count.ts`: full-chain mip count.
- `texture/texture-2d.ts`: shared texture facade.

The module has no import-time GPU work or mutable global state.

## Test Specification

`tests/lite/unit/ktx2-texture-array.test.ts` must cover:

- packed arrays, layer/mip ordering, dimensions, view shape, orientation, and sRGB;
- compressed format retention, block-padded copy extents, and authored mip uploads;
- unsupported compression features and unaligned-compression feature gating;
- device dimension/layer/mip limits and exact compressed/uncompressed payload sizes;
- malformed layer indices, dimensions, formats, mip counts, and layer counts;
- separate-buffer normalization, deterministic layer order, and fetch errors;
- zero-source runtime rejection for untyped callers;
- cleanup on synchronous upload/view/sampler failures and asynchronous validation/out-of-memory errors;
- ownership acquisition only after all error scopes succeed.

`tests/lite/unit/texture-array.test.ts` must cover image and pixel creation/upload, layer bounds, dimension equality, bitmap closure, mip generation, and URL failures.

`tests/lite/unit/engine-device-features.test.ts` must prove `texture-compression-unaligned` is requested only when offered. `tests/lite/unit/device-lost-recovery.test.ts` must prove the enabled feature is captured for replacement-device negotiation. Public API/report tests must expose the four native KTX2 entry points with non-empty tuple types on separate-source inputs.

## File Manifest

| File | Responsibility |
|---|---|
| `packages/babylon-lite/src/texture/texture-array.ts` | Public array facade, image/pixel upload, native packed/separate KTX2 validation and transactional upload |
| `packages/babylon-lite/src/texture/ktx2-texture-array.ts` | Compatibility RGBA8/base-level KTX2 array API |
| `packages/babylon-lite/src/texture/ktx2-loader.ts` | Shared decoder configuration and format selection |
| `packages/babylon-lite/src/texture/compressed-formats.ts` | Compressed format metadata |
| `packages/babylon-lite/src/index.ts` | Public package exports |
| `packages/babylon-lite/src/engine/engine.ts` | Initial optional-feature negotiation |
| `packages/babylon-lite/src/engine/device-lost-recovery.ts` | Capture of enabled features |
| `packages/babylon-lite/src/engine/device-lost-recovery-run.ts` | Replacement adapter/device feature enforcement |
| `tests/lite/unit/texture-array.test.ts` | Image and raw-pixel array behavior |
| `tests/lite/unit/ktx2-texture-array.test.ts` | Native KTX2 array behavior and failure ownership |
| `tests/lite/unit/engine-device-features.test.ts` | Initial optional-feature selection |
| `tests/lite/unit/device-lost-recovery.test.ts` | Recovery feature preservation |
