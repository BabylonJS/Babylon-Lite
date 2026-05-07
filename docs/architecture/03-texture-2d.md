# Module: Texture2D + KTX/KTX2 Loaders
> Package paths:
> - `packages/babylon-lite/src/texture/texture-2d.ts` — Image-based texture loading
> - `packages/babylon-lite/src/texture/ktx-loader.ts` — KTX1 compressed texture loading
> - `packages/babylon-lite/src/texture/ktx2-loader.ts` — KTX2/BasisU upload for glTF `KHR_texture_basisu`
> - `packages/babylon-lite/src/texture/compressed-formats.ts` — GL→WebGPU format mapping
> - `packages/babylon-lite/src/texture/record-mipmaps.ts` — Encoder-local mip generation for render-target textures
> - `packages/babylon-lite/src/texture/rtt-mip.ts` — Mipmapped render-target texture helper

## Purpose

Loads textures into WebGPU from three sources:

1. **Image textures** (`loadTexture2D`) — Loads PNG/JPG from URL via `ImageBitmap` → `rgba8unorm` GPU texture with optional mipmap generation.
2. **KTX1 compressed textures** (`loadKtxTexture2D`) — Loads GPU-compressed textures (ASTC, BC/DXT, ETC2) from KTX1 files with automatic format selection and PNG fallback. Fully tree-shakable: zero bytes if unused.
3. **KTX2/BasisU glTF texture sources** (`uploadKtx2Texture2D`) — Internal dynamic path used by the glTF `KHR_texture_basisu` extension. It loads Babylon's KTX2 decoder lazily, decodes/upload the full mip chain, and remains out of all scenes that do not declare `KHR_texture_basisu`.

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
```

### Functions

```typescript
export async function loadTexture2D(
  engine: Engine,
  url: string,
  opts?: Texture2DOptions,
): Promise<Texture2D>;

/**
 * Load a texture with KTX compressed format auto-selection and fallback.
 * Tries each suffix in priority order, picks the first whose compressed format
 * the GPU supports, fetches and parses the KTX1 file, and uploads compressed
 * mip data. Falls back to loadTexture2D(engine, baseUrl) if none work.
 *
 * Fully tree-shakable: only bundled when explicitly imported.
 */
export async function loadKtxTexture2D(
  engine: Engine,
  baseUrl: string,
  suffixes: string[],
  opts?: Texture2DOptions,
): Promise<Texture2D>;

/**
 * Internal glTF KHR_texture_basisu upload path.
 * Not exported from the public barrel; imported only by gltf-ext-basisu.ts.
 */
export async function uploadKtx2Texture2D(
  engine: EngineContextInternal,
  buffer: ArrayBuffer,
  sRGB: boolean,
): Promise<Texture2D>;

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

| Option         | Default     | Type            |
|----------------|-------------|-----------------|
| `mipMaps`      | `true`      | `boolean`       |
| `addressModeU` | `'repeat'`  | `GPUAddressMode`|
| `addressModeV` | `'repeat'`  | `GPUAddressMode`|
| `minFilter`    | `'linear'`  | `GPUFilterMode` |
| `magFilter`    | `'linear'`  | `GPUFilterMode` |
| `invertY`      | `true`      | `boolean`       |
| `srgb`         | `false`     | `boolean`       |

### Texture Creation Parameters

```typescript
device.createTexture({
  size: { width, height },           // from ImageBitmap dimensions
  format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
  mipLevelCount: mipMaps
    ? Math.floor(Math.log2(Math.max(width, height))) + 1
    : 1,
  usage: GPUTextureUsage.TEXTURE_BINDING
       | GPUTextureUsage.COPY_DST
       | GPUTextureUsage.RENDER_ATTACHMENT,
})
```

**Mip level formula:** `Math.floor(Math.log2(Math.max(width, height))) + 1`

Example: 512×256 image → `Math.floor(log2(512)) + 1 = 9 + 1 = 10` mip levels.

### Image Upload

```typescript
device.queue.copyExternalImageToTexture(
  { source: imageBitmap, flipY: invertY },
  { texture },
  { width, height },
)
```

### Sampler Configuration

```typescript
device.createSampler({
  addressModeU,                             // default: 'repeat'
  addressModeV,                             // default: 'repeat'
  minFilter: opts.minFilter ?? 'linear',
  magFilter: opts.magFilter ?? 'linear',
  mipmapFilter: mipMaps ? 'linear' : 'nearest',
  maxAnisotropy: 4,
})
```

### Internal Mipmap Generator

```typescript
async function generateMipmaps(
  device: GPUDevice,
  texture: GPUTexture,
  _width: number,
  _height: number,
  mipLevelCount: number,
): Promise<void>
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

**No cleanup/dispose API** — the returned `Texture2D` is an immutable value object. GPU resources are released by garbage collection or manual `texture.destroy()` by the caller.

---

## Babylon.js Equivalence Map

| Babylon Lite                        | Babylon.js                                                |
|-------------------------------------|-----------------------------------------------------------|
| `loadTexture2D(engine, url, opts)` | `new Texture(url, scene, ...options)`                     |
| `Texture2D` interface              | `Texture` class (internal GPU texture + sampler)          |
| `Texture2DOptions.mipMaps`         | `Texture.noMipmap` (inverted: `mipMaps = !noMipmap`)     |
| `Texture2DOptions.addressModeU`    | `Texture.wrapU` (enum values differ)                      |
| `Texture2DOptions.addressModeV`    | `Texture.wrapV`                                           |
| `Texture2DOptions.invertY`         | `Texture.invertY` (default true in both)                  |
| `maxAnisotropy: 4`                | `Texture.anisotropicFilteringLevel` (default 4)           |
| `format: 'rgba8unorm'`            | Standard RGBA format for loaded images                     |
| `generateMipmaps()` (render-based) | `Engine.generateMipmaps()` (may use compute or render)    |
| No `dispose()`                     | `Texture.dispose()` for explicit cleanup                   |

---

## Dependencies

- `texture/compressed-formats.ts` — GL internal format → WebGPU format map (imported only by ktx-loader)
- `resource/gpu-pool.ts` — `acquireTexture`, `getOrCreateSampler`
- WebGPU API types (GPUDevice, GPUTexture, GPUSampler, etc.)
- Browser APIs: `fetch`, `createImageBitmap`

---

## KTX1 Compressed Texture Loading

### Supported Formats

| Format Family | GL Hex Range | WebGPU Format | Device Feature |
|--------------|-------------|---------------|----------------|
| BC / S3TC / DXT | 0x83F0–0x8E8D | bc1..bc7 | `texture-compression-bc` |
| ETC2 / EAC | 0x9270–0x9279 | etc2/eac | `texture-compression-etc2` |
| ASTC 4×4–12×12 | 0x93B0–0x93DD | astc-NxM | `texture-compression-astc` |
| PVRTC | — | *(not in WebGPU)* | — |

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

---

## File Manifest

| File | Role |
|------|------|
| `src/texture/texture-2d.ts` | Image loading, GPU texture creation, mipmap generation, sampler creation |
| `src/texture/ktx-loader.ts` | KTX1 parser, compressed texture upload, suffix selection, fallback to loadTexture2D |
| `src/texture/ktx2-loader.ts` | Internal KTX2/BasisU decoder bridge and Texture2D upload for glTF `KHR_texture_basisu` |
| `src/texture/compressed-formats.ts` | GL `glInternalFormat` → `{ gpuFormat, feature, blockW, blockH, blockBytes }` lookup table (lazy-init) |
| `src/texture/solid-texture.ts` | Procedural 1×1 solid color texture |
| `src/texture/generate-mipmaps.ts` | GPU mipmap generation via render passes |
| `src/texture/record-mipmaps.ts` | Encoder-local mip generation used by scene-scoped opaque refraction RTT |
| `src/texture/rtt-mip.ts` | Mipmapped render-target texture helper used by scene-scoped opaque refraction RTT |
