# Module: Texture2D + KTX/KTX2 Loaders

> Package paths:
>
> - `packages/babylon-lite/src/texture/texture-2d.ts` — Image-based texture loading
> - `packages/babylon-lite/src/texture/external-image-texture.ts` — Independently-owned texture creation from decoded external images
> - `packages/babylon-lite/src/texture/ktx-loader.ts` — KTX1 compressed texture loading
> - `packages/babylon-lite/src/texture/ktx2-loader.ts` — KTX2/BasisU upload for glTF `KHR_texture_basisu`
> - `packages/babylon-lite/src/texture/compressed-formats.ts` — GL→WebGPU format mapping
> - `packages/babylon-lite/src/texture/mip-count.ts` — Biased mip-count helper for transmission refraction

## Purpose

Loads textures into WebGPU from four sources:

1. **Image textures** (`loadTexture2D`) — Loads PNG/JPG from URL via `ImageBitmap` → `rgba8unorm` GPU texture with optional mipmap generation.
2. **Decoded external images** (`createTexture2DFromExternalImage`) — Uploads an `ImageBitmap`, `ImageData`, canvas, image, video, or `VideoFrame` into a fresh, independently-owned texture, with optional aspect-preserving downscaling.
3. **KTX1 compressed textures** (`loadKtxTexture2D`) — Loads GPU-compressed textures (ASTC, BC/DXT, ETC2) from KTX1 files with automatic format selection and PNG fallback. Fully tree-shakable: zero bytes if unused.
4. **KTX2/BasisU glTF texture sources** (`uploadKtx2Texture2D`) — Internal dynamic path used by the glTF `KHR_texture_basisu` extension. It loads Babylon's KTX2 decoder lazily, decodes/upload the full mip chain, and remains out of all scenes that do not declare `KHR_texture_basisu`.

Both return the same `Texture2D` interface — callers can't tell whether they got compressed or uncompressed.

---

## Public API Surface

### Interfaces

```typescript
export interface Texture2D {
    texture: GPUTexture;
    view: GPUTextureView;
    sampler: GPUSampler;
    width: number;
    height: number;
}

export interface Texture2DOptions {
    /** Generate mipmaps. Default true. */
    mipMaps?: boolean;
    /** Address mode U. Default 'repeat'. */
    addressModeU?: GPUAddressMode;
    /** Address mode V. Default 'repeat'. */
    addressModeV?: GPUAddressMode;
    /** Min filter. Default 'linear'. */
    minFilter?: GPUFilterMode;
    /** Mag filter. Default 'linear'. */
    magFilter?: GPUFilterMode;
    /** Flip Y axis during upload. Default true (matches Babylon.js convention). */
    invertY?: boolean;
    /** Use sRGB format (rgba8unorm-srgb). Enables hardware sRGB→linear on sample.
     *  Use for color/albedo textures in PBR workflows. Default false. */
    srgb?: boolean;
}

export interface ExternalImageTexture2DOptions extends Texture2DOptions {
    /**
     * Downscale images whose larger dimension exceeds this value. The larger
     * output dimension is exactly `maxDimension`; the other is rounded to the
     * nearest positive integer to preserve aspect ratio. Smaller images are
     * never enlarged. Must be a positive integer when provided.
     */
    maxDimension?: number;
}
```

### Functions

```typescript
export async function loadTexture2D(engine: Engine, url: string, opts?: Texture2DOptions): Promise<Texture2D>;

/**
 * Create a fresh Texture2D from an already-decoded WebGPU external-image
 * source. Every invocation allocates a distinct GPUTexture; there is no URL or
 * source-identity cache. The caller retains ownership of `source`, and the
 * function never closes or mutates it.
 *
 * The returned texture owns one resource-pool reference. The caller must call
 * `releaseTexture(texture)` after all material bindings have released it.
 * Decode/resample, source validation, allocation, upload, and mip-generation
 * failures reject the promise; no fallback texture is returned.
 */
export async function createTexture2DFromExternalImage(engine: EngineContext, source: GPUCopyExternalImageSource, options?: ExternalImageTexture2DOptions): Promise<Texture2D>;

/**
 * Load a texture with KTX compressed format auto-selection and fallback.
 * Tries each suffix in priority order, picks the first whose compressed format
 * the GPU supports, fetches and parses the KTX1 file, and uploads compressed
 * mip data. Falls back to loadTexture2D(engine, baseUrl) if none work.
 *
 * Fully tree-shakable: only bundled when explicitly imported.
 */
export async function loadKtxTexture2D(engine: Engine, baseUrl: string, suffixes: string[], opts?: Texture2DOptions): Promise<Texture2D>;

/**
 * Internal glTF KHR_texture_basisu upload path.
 * Not exported from the public barrel; imported only by gltf-ext-basisu.ts.
 */
export async function uploadKtx2Texture2D(engine: EngineContextInternal, buffer: ArrayBuffer, sRGB: boolean): Promise<Texture2D>;

/**
 * Internal KTX2 mip0 decode for ORM composition fallback.
 */
export async function decodeKtx2ImageBitmapFromBuffer(buffer: ArrayBuffer): Promise<ImageBitmap>;
```

### Imports

Imports `Engine` from the engine module (to access `GPUDevice` internally), plus `acquireTexture`/`getOrCreateSampler` from the resource pool.

---

## Internal Architecture

### Default Option Values

| Option         | Default    | Type             |
| -------------- | ---------- | ---------------- |
| `mipMaps`      | `true`     | `boolean`        |
| `addressModeU` | `'repeat'` | `GPUAddressMode` |
| `addressModeV` | `'repeat'` | `GPUAddressMode` |
| `minFilter`    | `'linear'` | `GPUFilterMode`  |
| `magFilter`    | `'linear'` | `GPUFilterMode`  |
| `invertY`      | `true`     | `boolean`        |
| `srgb`         | `false`    | `boolean`        |

### Texture Creation Parameters

```typescript
device.createTexture({
    size: { width, height }, // from ImageBitmap dimensions
    format: srgb ? "rgba8unorm-srgb" : "rgba8unorm",
    mipLevelCount: mipMaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
});
```

**Mip level formula:** `Math.floor(Math.log2(Math.max(width, height))) + 1`

Example: 512×256 image → `Math.floor(log2(512)) + 1 = 9 + 1 = 10` mip levels.

### Image Upload

```typescript
device.queue.copyExternalImageToTexture({ source: imageBitmap, flipY: invertY }, { texture }, { width, height });
```

### Decoded External-Image Upload

`createTexture2DFromExternalImage` reads intrinsic dimensions without requiring
DOM constructors:

1. `displayWidth` / `displayHeight` for `VideoFrame`
2. `videoWidth` / `videoHeight` for video elements
3. `naturalWidth` / `naturalHeight` for image elements
4. `width` / `height` for `ImageBitmap`, `ImageData`, and canvas sources

The first complete, positive integer pair wins. A source with no supported size
pair throws `TypeError` before any GPU allocation.

When `maxDimension` is smaller than the source's larger dimension, the helper
creates a temporary resized `ImageBitmap`:

```typescript
const scale = maxDimension / Math.max(sourceWidth, sourceHeight);
const width = sourceWidth >= sourceHeight ? maxDimension : Math.max(1, Math.round(sourceWidth * scale));
const height = sourceHeight >= sourceWidth ? maxDimension : Math.max(1, Math.round(sourceHeight * scale));
const resized = await createImageBitmap(source, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "high",
    premultiplyAlpha: premultiplyAlpha ? "premultiply" : "none",
    colorSpaceConversion: "none",
});
```

The temporary bitmap is always closed after upload or failure. The original
source is never closed. Without downscaling, the original source is copied
directly, avoiding an intermediate allocation unless opt-in device-lost
recovery is active. Recovery retains a factory-owned `ImageBitmap` copy so the
caller remains free to close its source immediately. The immutable copy is
created before upload and is used for both the initial upload and any recovery,
so mutable canvases and videos cannot replay a later frame. It is closed when
the texture's final ownership reference is released. This works in workers
because `ImageBitmap`, `ImageData`, `OffscreenCanvas`, `VideoFrame`, and
`createImageBitmap` do not require the document DOM.

The texture factory contains no recovery-specific branches, metadata encoding,
or ownership rules. It makes one opaque optional capture call after upload.
The recovery enabler installs that seam and owns copying, metadata capture,
tracking, rebuilding, and release through its own opaque pool hook. Consumers
that do not enable recovery retain none of that implementation.

The destination texture and sampler match `loadTexture2D`: RGBA8 linear or
sRGB format, optional full mip chain, caller-selected filtering/addressing,
explicit `invertY` (default `true`), and explicit premultiplied-alpha handling.
The mipmap module is resolved before opening nested WebGPU `validation` and
`out-of-memory` error scopes. Allocation, upload, mip generation, and sampler
creation then run synchronously inside those scopes, preventing concurrent
calls from interleaving the device-global scope stack. Synchronous platform
exceptions reject unchanged; scoped GPU errors reject with the GPU error as
their cause. The destination is destroyed on either path and no fallback
texture is returned.

#### Minimal Usage

```typescript
import { createTexture2DFromExternalImage, releaseTexture } from "@babylonjs/lite";

const bitmap = await createImageBitmap(blob);
const texture = await createTexture2DFromExternalImage(engine, bitmap, {
    maxDimension: 2048,
    invertY: true,
    srgb: true,
});
bitmap.close(); // source remains caller-owned

material.diffuseTexture = texture;
// After removing it from every material:
releaseTexture(texture);
```

#### Migration from a Custom Image Loader

```typescript
// Before: application code decoded, resized, and uploaded a private texture.
const image = await decodeApplicationImage(imageUrl);
const texture = await createTexture2DFromExternalImage(engine, image, {
    maxDimension: maxTextureSize,
    invertY: true,
    srgb: true,
});

// Keep one Texture2D per independently-owned image. Do not replace this with
// loadTexture2D(imageUrl), whose URL cache intentionally shares.
material.diffuseTexture = texture;

// During teardown, after material references are removed:
releaseTexture(texture);
image.close();
```

### Sampler Configuration

```typescript
device.createSampler({
    addressModeU, // default: 'repeat'
    addressModeV, // default: 'repeat'
    minFilter: opts.minFilter ?? "linear",
    magFilter: opts.magFilter ?? "linear",
    mipmapFilter: mipMaps ? "linear" : "nearest",
    maxAnisotropy: 4,
});
```

### Internal Mipmap Generator

```typescript
async function generateMipmaps(device: GPUDevice, texture: GPUTexture, _width: number, _height: number, mipLevelCount: number): Promise<void>;
```

**Algorithm:**

1. Create an inline WGSL shader module with:
    - **Vertex shader:** Generates a fullscreen triangle from 3 hardcoded vertices
    - **Fragment shader:** Samples source mip level and returns color
2. Create a linear sampler for downsampling
3. Create a render pipeline
4. For each mip level from 1 to `mipLevelCount - 1`:
   a. Create a texture view of the previous level (source)
   b. Create a texture view of the current level (destination)
   c. Create a bind group binding source view + sampler
   d. Begin a render pass targeting the destination view
   e. Draw 3 vertices (fullscreen triangle)
5. Submit the command buffer

**Inline mipmap shader (embedded in function body):**

```wgsl
// Vertex: fullscreen triangle
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0)
  );
  return vec4(pos[i], 0.0, 1.0);
}

// Fragment: sample previous mip level
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  return textureSample(src, samp, pos.xy / vec2<f32>(textureDimensions(src)));
}
```

---

## Pipeline Configuration

This module does not create a main rendering pipeline. It only creates a temporary pipeline for mipmap generation:

**Mipmap Generation Pipeline:**

- Vertex: no vertex buffers (fullscreen triangle from vertex_index)
- Fragment: samples source texture, writes to destination mip level
- Color target: `rgba8unorm` (same as texture format)
- No depth/stencil
- Topology: `triangle-list`

---

## Shader Logic

No standalone shader files. The mipmap generation shader is embedded inline (see Internal Architecture above).

**Mipmap downsampling formula:**
Each mip level is generated by rendering a fullscreen triangle that samples the previous level with a linear sampler, producing a 2× downscaled result via hardware bilinear filtering.

---

## State Machine / Lifecycle

```
loadTexture2D(engine, url, opts)
  │
  ├─ 1. Parse options (apply defaults)
  ├─ 2. Fetch image: fetch(url) → blob → createImageBitmap
  ├─ 3. Calculate mip level count from image dimensions
  ├─ 4. Create GPUTexture (rgba8unorm, with mip levels)
  ├─ 5. Upload image data: copyExternalImageToTexture (with flipY)
  ├─ 6. If mipMaps: await generateMipmaps(device, texture, w, h, levels)
  │     ├─ Create shader module (inline WGSL)
  │     ├─ Create sampler (linear)
  │     ├─ Create render pipeline
  │     ├─ For each level 1..N-1:
  │     │   ├─ Create source view (level-1)
  │     │   ├─ Create dest view (level)
  │     │   ├─ Create bind group
  │     │   ├─ Render pass: draw fullscreen triangle
  │     │   └─ End pass
  │     └─ Submit command buffer
  ├─ 7. Create GPUSampler (with anisotropy, mipmap filter)
  └─ 8. Return { texture, view: texture.createView(), sampler, width, height }
```

```
createTexture2DFromExternalImage(engine, source, opts)
  │
  ├─ 1. Validate source dimensions and maxDimension
  ├─ 2. If required, resize to a temporary ImageBitmap (aspect ratio preserved)
  ├─ 3. Create a new GPUTexture (never cached)
  ├─ 4. Upload with explicit flipY / premultipliedAlpha
  ├─ 5. Generate mipmaps when enabled
  ├─ 6. Create/reuse the configured sampler
  ├─ 7. If recovery is active, retain a factory-owned decoded image and settings
  ├─ 8. Acquire one caller-owned resource-pool reference
  ├─ 9. Close any non-retained temporary resized bitmap
  └─ 10. Return a normal Texture2D
```

**Ownership:** `createTexture2DFromExternalImage` acquires one caller-owned
reference. Material bindings acquire and release their own references. The
factory's caller must call `releaseTexture(texture)` after the texture is
detached from all materials. The factory never owns or closes the supplied
source. If device-lost recovery is active, the factory owns a separate retained
bitmap and closes it when the final texture reference is released.

---

## Babylon.js Equivalence Map

| Babylon Lite                                             | Babylon.js                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `loadTexture2D(engine, url, opts)`                       | `new Texture(url, scene, ...options)`                      |
| `createTexture2DFromExternalImage(engine, source, opts)` | `new Texture(null, scene)` + private external-image upload |
| `Texture2D` interface                                    | `Texture` class (internal GPU texture + sampler)           |
| `Texture2DOptions.mipMaps`                               | `Texture.noMipmap` (inverted: `mipMaps = !noMipmap`)       |
| `Texture2DOptions.addressModeU`                          | `Texture.wrapU` (enum values differ)                       |
| `Texture2DOptions.addressModeV`                          | `Texture.wrapV`                                            |
| `Texture2DOptions.invertY`                               | `Texture.invertY` (default true in both)                   |
| `maxAnisotropy: 4`                                       | `Texture.anisotropicFilteringLevel` (default 4)            |
| `format: 'rgba8unorm'`                                   | Standard RGBA format for loaded images                     |
| `generateMipmaps()` (render-based)                       | `Engine.generateMipmaps()` (may use compute or render)     |
| `releaseTexture(texture)`                                | `Texture.dispose()` for explicit cleanup                   |

---

## Dependencies

- `texture/compressed-formats.ts` — GL internal format → WebGPU format map (imported only by ktx-loader)
- `resource/gpu-pool.ts` — `acquireTexture`, `getOrCreateSampler`
- WebGPU API types (GPUDevice, GPUTexture, GPUSampler, etc.)
- Platform APIs: `fetch`, `createImageBitmap`; decoded-image creation and resizing remain worker-compatible and do not require `document`

---

## KTX1 Compressed Texture Loading

### Supported Formats

| Format Family   | GL Hex Range  | WebGPU Format     | Device Feature             |
| --------------- | ------------- | ----------------- | -------------------------- |
| BC / S3TC / DXT | 0x83F0–0x8E8D | bc1..bc7          | `texture-compression-bc`   |
| ETC2 / EAC      | 0x9270–0x9279 | etc2/eac          | `texture-compression-etc2` |
| ASTC 4×4–12×12  | 0x93B0–0x93DD | astc-NxM          | `texture-compression-astc` |
| PVRTC           | —             | _(not in WebGPU)_ | —                          |

### KTX1 Binary Format (64-byte header)

```
Offset  Size  Field
 0      12    Magic: «KTX 11»\r\n\x1A\n
12       4    endianness (0x04030201 = little-endian)
16       4    glType (0 = compressed)
24       4    glFormat (0 = compressed)
28       4    glInternalFormat → lookup in compressed-formats.ts
36       4    pixelWidth
40       4    pixelHeight
56       4    numberOfMipmapLevels
60       4    bytesOfKeyValueData
```

After header + key/value metadata, mip levels are stored largest-first:

- `uint32 imageSize` + `imageData[imageSize]` + padding to 4-byte alignment

### `loadKtxTexture2D` Flow

```
loadKtxTexture2D(engine, "grid.png", ["-astc.ktx", "-dxt.ktx", "-etc2.ktx"])
  ├─ For each suffix: check device.features.has(requiredFeature)
  ├─ For each supported suffix (try all, not just first):
  │   ├─ Rewrite URL: "grid.png" → "grid-dxt.ktx"
  │   ├─ fetch → ArrayBuffer → parseKtx1 → uploadCompressed
  │   └─ On success: return Texture2D
  │   └─ On failure: warn, try next suffix
  └─ Fallback: loadTexture2D(engine, "grid.png")
```

### Tree-Shaking

`loadKtxTexture2D` lives in `ktx-loader.ts` which statically imports `compressed-formats.ts`.
If a scene never imports `loadKtxTexture2D`, both modules are fully tree-shaken to 0 bytes.
`loadTexture2D` is NOT modified — zero bleed into non-KTX scenes.

---

## KTX2 / `KHR_texture_basisu` Loading

KTX2 support is intentionally **not** a public direct texture API today. It is scoped to glTF assets that declare `KHR_texture_basisu`, keeping the decoder glue and texture upload path out of every non-KTX2 scene.

### Runtime Flow

```
loadGltf(engine, url)
  ├─ sees extensionsUsed includes KHR_texture_basisu
  ├─ dynamic import("./gltf-ext-basisu.js")
  ├─ gltf-ext-basisu strips KTX2 textureInfos from core material parsing
  ├─ fetch image.uri or bufferView bytes for the referenced KTX2 image
  ├─ dynamic decoder script: https://cdn.babylonjs.com/babylon.ktx2Decoder.js
  ├─ decoder.decode(..., { forceRGBA: true }) returns mip levels
  └─ uploadKtx2Texture2D() creates Texture2D with full mip chain
```

### Upload Rules

- Color textures use `rgba8unorm-srgb`; normal/ORM textures use linear formats.
- The decoder path currently forces RGBA output for visual parity with Babylon.js FlightHelmetKTX.
- The uploaded texture preserves the decoder-provided mip chain; no extra `generateMipmaps()` call is needed.
- Samplers use repeat addressing, linear min/mag filtering, linear mip filtering when mips exist, and anisotropy 4 for mipmapped textures.
- `decodeKtx2ImageBitmapFromBuffer()` decodes mip0 to `ImageBitmap` only when the extension must compose a split metallic-roughness + occlusion ORM texture.

### Tree-Shaking

`ktx2-loader.ts` is imported only by `loader-gltf/gltf-ext-basisu.ts`, which itself is dynamic-imported only when the asset declares `KHR_texture_basisu`. This keeps KTX2 decoder code, CDN script setup, and ORM composition out of existing KTX1, Basis `.basis`, and plain image scenes.

---

## Test Specification

1. **Mip level count** — 1024×1024: 11 levels. 512×256: 10 levels. 1×1: 1 level.
2. **Default options** — Verify all defaults are applied when `opts = {}`.
3. **No mipmap mode** — With `mipMaps: false`: mipLevelCount = 1, mipmapFilter = `'nearest'`.
4. **Sampler configuration** — Verify `maxAnisotropy = 4`, address modes match options.
5. **InvertY** — Default true; image should be flipped vertically during upload.
6. **Texture format** — Always `rgba8unorm`.
7. **Texture usage flags** — Must include TEXTURE_BINDING, COPY_DST, and RENDER_ATTACHMENT.
8. **Return shape** — Must contain `texture`, `view`, `sampler`, `width`, `height`.
9. **KTX2 glTF path** — Scene 112 loads FlightHelmetKTX via `KHR_texture_basisu`, stays below its bundle ceiling, and does not increase runtime-loaded JS for existing scenes.
10. **Independent decoded images** — Two calls with one source create different GPU textures and each takes one ownership reference.
11. **External-image sizing** — Recognize bitmap/data/canvas, image, video, and VideoFrame dimension shapes; reject unsupported or zero-sized sources before allocation.
12. **Aspect-preserving downscale** — Clamp only when the larger dimension exceeds `maxDimension`, preserve orientation/aspect ratio, and never upscale.
13. **External-image ownership** — Close temporary resized bitmaps on success and failure; never close the caller's source.
14. **External-image failures** — Propagate resize/decode and upload failures and destroy partially-created GPU textures; never return a fallback.
15. **External-image tree shaking** — A consumer that imports another root API retains no `createTexture2DFromExternalImage` implementation code.
16. **Concurrent external-image uploads** — Concurrent mipmapped calls keep validation and out-of-memory errors associated with the invocation that issued them.
17. **External-image recovery** — Opt-in device-lost recovery uses one factory-owned immutable image for both initial upload and replay, restores upload and sampler settings, and releases the retained image with the texture.
18. **Recovery isolation** — External-image consumers that do not enable device-lost recovery retain no capture, recovery-source encoding, or retained-image release implementation.

---

## File Manifest

| File                                    | Role                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/texture/texture-2d.ts`             | Image loading, GPU texture creation, mipmap generation, sampler creation                                          |
| `src/texture/external-image-texture.ts` | Fresh external-image upload, source sizing, optional aspect-preserving downscaling, and explicit caller ownership |
| `src/texture/ktx-loader.ts`             | KTX1 parser, compressed texture upload, suffix selection, fallback to loadTexture2D                               |
| `src/texture/ktx2-loader.ts`            | Internal KTX2/BasisU decoder bridge and Texture2D upload for glTF `KHR_texture_basisu`                            |
| `src/texture/compressed-formats.ts`     | GL `glInternalFormat` → `{ gpuFormat, feature, blockW, blockH, blockBytes }` lookup table (lazy-init)             |
| `src/texture/solid-texture.ts`          | Procedural 1×1 solid color texture                                                                                |
| `src/texture/generate-mipmaps.ts`       | GPU mipmap generation via render passes, including encoder-local recording                                        |
| `src/texture/mip-count.ts`              | Shared biased mip-count helper used by frame-graph transmission                                                   |
