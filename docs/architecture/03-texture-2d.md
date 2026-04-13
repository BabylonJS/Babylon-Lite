# Module: Texture2D
> Package path: `packages/babylon-lite/src/texture/texture-2d.ts`

## Purpose

Loads an image from a URL into a WebGPU texture with optional mipmap generation. Returns a ready-to-bind `Texture2D` object containing the GPU texture and a configured sampler. This is the standard texture loading path for all materials in Babylon Lite.

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
loadTexture2D(device, url, opts)
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
| `loadTexture2D(device, url, opts)` | `new Texture(url, scene, ...options)`                     |
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

- None (self-contained module)
- WebGPU API types (GPUDevice, GPUTexture, GPUSampler, etc.)
- Browser APIs: `fetch`, `createImageBitmap`

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

---

## File Manifest

| File | Role |
|------|------|
| `src/texture/texture-2d.ts` | Image loading, GPU texture creation, mipmap generation, sampler creation |
