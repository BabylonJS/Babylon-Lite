# Module: Resource Pool

> Package path: `packages/babylon-lite/src/resource/`

## Purpose

Provides GPU resource lifecycle management: reference-counted texture ownership, deduplicated sampler creation, and focused GPU buffer creation utilities. Side-effect-free facades preserve the existing APIs while separate implementation modules let bundling retain only the operation groups actually used.

## Public API Surface

### Texture Ref Counting

```typescript
/** Increment ref count on a Texture2D. First acquire sets count to 1. */
export function acquireTexture(tex: Texture2D): void;

/** Decrement ref count. Calls tex.texture.destroy() when count reaches 0.
 *  Returns true if the texture was destroyed. */
export function releaseTexture(tex: Texture2D): boolean;

/** Increment ref count on a raw GPUTexture (for env textures). */
export function acquireGPUTexture(tex: GPUTexture): void;

/** Decrement ref count on a raw GPUTexture. Destroys at 0.
 *  Returns true if the texture was destroyed. */
export function releaseGPUTexture(tex: GPUTexture): boolean;
```

### Internal Texture State and Capture Seam

```typescript
/** Install the opaque release notification used by opt-in resource capture. */
export function _setTextureReleaseHook(hook: (tex: Texture2D) => void): void;

/** True only when the current GPUTexture has a retained zero-count entry. */
export function _isTextureReleased(tex: Texture2D): boolean;

/** Return the current GPUTexture owner count, or 0 when no entry exists. */
export function _textureOwners(tex: Texture2D): number;
```

### Sampler Deduplication

```typescript
/** Get or create a deduplicated sampler. Same config → same GPUSampler.
 *  Default: all nearest, clamp-to-edge, anisotropy 1. */
export function getOrCreateSampler(engine: EngineContext, desc?: GPUSamplerDescriptor): GPUSampler;

/** Clear sampler cache for a device. */
export function clearSamplerCache(engine: EngineContext): void;
```

## Internal Architecture

### Module Boundaries

- `gpu-pool.ts` is a side-effect-free re-export facade. Existing imports and the package root API remain unchanged.
- `texture-references.ts` is the side-effect-free facade for `Texture2D` ownership operations.
- `texture-acquire.ts` owns facade acquisition and captures `texture.texture` once before reading or updating its count.
- `texture-release.ts` forwards the captured allocation and its facade to shared release bookkeeping.
- `gpu-texture-references.ts` is the compatibility facade for the separate raw acquisition and release modules.
- `gpu-texture-acquire.ts` owns the shared increment operation; facade acquisition forwards one captured allocation.
- `gpu-texture-release.ts` forwards raw releases without facade metadata.
- `texture-allocation-release.ts` owns the shared decrement/destroy/retained-zero operation and optional facade notification. A hook may retarget a facade without redirecting the captured allocation's retained-zero update.
- `texture-owner-state.ts` owns the recovery-facing released/owner queries.
- `texture-reference-store.ts` supplies the one shared, lazily allocated texture-count `WeakMap`.
- `sampler-pool.ts` independently owns sampler keys and its lazily allocated per-device cache.

There are no module-initialization allocations. The texture-count and sampler-cache `WeakMap` instances, and each device's sampler `Map`, are created only on first use.

### Buffer Operation Boundaries

- `gpu-buffers.ts` is a side-effect-free facade preserving the existing buffer utility exports.
- `buffer-alignment.ts` owns the generic `align(n, to)` operation.
- `empty-uniform-buffer.ts` owns aligned `UNIFORM | COPY_DST` allocation without an initial upload.
- `uniform-buffer.ts` composes empty uniform allocation with the initial queue upload and destroys the unpublished buffer if that upload fails.
- `mapped-buffer.ts` owns mapped-at-creation vertex/index/storage uploads, including minimum-size and four-byte alignment.

These boundaries keep sprite and other focused consumers from retaining unrelated buffer upload strategies through the compatibility facade.

### Texture Reference Counting

Uses `WeakMap<GPUTexture, number>` for ref counts:

- **`_textureReferences`**: Maps `GPUTexture` → reference count (number)
- `acquireTexture(tex)` / `acquireGPUTexture(tex)`: Increments count (defaults to 0 if not present, so first acquire → 1)
- `releaseTexture(tex)` / `releaseGPUTexture(tex)`: Decrements count (defaults to 1 if not present, so first release → 0 → destroy)
- At count 0: calls `tex.texture.destroy()` (Texture2D) or `tex.destroy()` (raw GPUTexture), then retains a zero-count WeakMap entry
- `releaseTexture` ordering is exact: destroy the GPU texture, notify the optional facade release hook, then write count zero
- `releaseGPUTexture` never calls the facade hook; it destroys, then writes count zero
- Returns `true` if destroyed, `false` if still referenced

**WeakMap rationale**: No memory leaks — if the `GPUTexture` object itself is GC'd (impossible while alive), the entry is automatically cleaned up. More importantly, WeakMap avoids needing explicit cleanup of the tracking map.

The retained zero distinguishes a released allocation from a texture that never had an owner. Both report `_textureOwners(tex) === 0`, but only the released allocation reports `_isTextureReleased(tex) === true`.

Two API variants:

- `acquireTexture` / `releaseTexture`: Takes `Texture2D` (the public API type) and snapshots `.texture` at function entry. A release hook may replace the facade's allocation, but destruction and the retained-zero write still target the captured allocation.
- `acquireGPUTexture` / `releaseGPUTexture`: Takes raw `GPUTexture` directly (used internally for environment cubemaps, BRDF LUTs, etc.)

### Sampler Deduplication

Uses `WeakMap<GPUDevice, Map<string, GPUSampler>>` for per-device caching:

- **`_samplerCache`**: Maps device → descriptor-key → sampler
- Key format: `"minFilter:magFilter:mipmapFilter:addressModeU:addressModeV:addressModeW:maxAnisotropy"`
    - Example: `"linear:linear:nearest:clamp-to-edge:clamp-to-edge:clamp-to-edge:1"`
    - Defaults applied: nearest for filters, clamp-to-edge for address modes, 1 for anisotropy
- First call with a new key creates the sampler; subsequent calls return cached instance
- `getOrCreateSampler(engine, desc)` reads `engine._device`, passes the original descriptor unchanged to `device.createSampler`, and caches the result under the computed key
- `clearSamplerCache(engine)` removes all cached samplers for `engine._device`

**WeakMap<GPUDevice>** ensures the cache is automatically invalidated when a device is lost/destroyed without explicit cleanup.

Sampler cache ownership is device-scoped, not scene- or material-group-scoped. `GPUSampler` objects are immutable and have no explicit destroy operation, and several scenes may share one engine/device cache. Standard/PBR group disposal therefore clears only its own pipeline cache and must not call `clearSamplerCache(engine)`. `clearSamplerCache` remains an explicit operation for callers that intentionally want to evict the complete cache for one device; a later lookup recreates entries on demand.

### Memory Layout

No buffers or GPU memory managed. This module only tracks ownership via JavaScript-side data structures:

```
_textureReferences: WeakMap<GPUTexture, number>
  └── Key: GPUTexture instance
  └── Value: integer ref count, including retained 0 after destruction

_samplerCache: WeakMap<GPUDevice, Map<string, GPUSampler>>
  └── Key: GPUDevice instance
  └── Value: Map from descriptor string key → GPUSampler
```

## Pipeline Configuration

N/A — No GPU pipelines. This module manages texture lifecycle and sampler creation.

## Shader Logic

N/A — No shaders.

## State Machine / Lifecycle

### Texture Lifecycle

```
Texture created (loadTexture2D, createSolidTexture2D, etc.)
     │
     ▼
acquireTexture(tex) ──► refCount = 1
     │
     ├── acquireTexture(tex) ──► refCount++
     │
     ├── releaseTexture(tex) ──► refCount--
     │         │
     │         ├── refCount > 0: keep alive
     │         │
     │         └── refCount <= 0:
     │               tex.texture.destroy()
     │               optional facade release hook
     │               retain refCount = 0
     │               return true
     │
     └── (GPUTexture GC'd if all JS refs gone — WeakMap entry auto-cleaned)
```

### Sampler Lifecycle

```
getOrCreateSampler(engine, desc)
     │
     ├── Cache hit: return existing GPUSampler
     │
     └── Cache miss: engine._device.createSampler(desc), cache, return

clearSamplerCache(engine)
     └── Explicitly delete all entries for engine._device

Scene/material-group disposal
     └── Leave the shared device sampler cache intact
```

## Babylon.js Equivalence Map

| Babylon.js                                          | Babylon Lite                                         |
| --------------------------------------------------- | ---------------------------------------------------- |
| `ThinEngine._samplerCache`                          | `_samplerCache` WeakMap + `getOrCreateSampler()`     |
| `Texture.dispose()` + `InternalTexture._references` | `acquireTexture()` / `releaseTexture()` ref counting |
| `BaseTexture.releaseInternalTexture()`              | `releaseGPUTexture()`                                |

## Dependencies

- `../texture/texture-2d.js` — type-only `Texture2D` dependency for facade ownership and queries
- `../engine/engine.js` — type-only `EngineContext` dependency for sampler operations
- `texture-reference-store.ts` — shared lazy count store used by raw, facade, and query modules

## Test Specification

1. **Acquire/release basic**: Acquire once, release once → texture destroyed, returns true
2. **Multiple acquires**: Acquire 3 times, release 2 times → not destroyed; release 3rd → destroyed
3. **Default release**: Release without prior acquire → treats as count 1, destroys
4. **Sampler dedup**: Same descriptor returns same GPUSampler instance
5. **Sampler different desc**: Different descriptor returns different GPUSampler
6. **Sampler key**: Verify key includes all 7 descriptor fields with defaults
7. **Clear sampler cache**: Verify cache cleared; next call creates new sampler
8. **Device isolation**: Two devices maintain separate sampler caches
9. **GPUTexture variant**: Verify `acquireGPUTexture`/`releaseGPUTexture` work identically for raw textures
10. **Mixed ownership**: Raw and facade owners share one count
11. **Release ordering**: Facade release destroys, calls the hook while the old count is observable, then records zero
12. **Absent owner**: Raw and facade release default to one implicit owner and destroy
13. **Descriptor passthrough**: Sampler creation receives the original descriptor unchanged
14. **Release retargeting**: A release hook may replace `texture.texture`; only the captured old allocation is destroyed and marked zero
15. **Acquire capture**: Facade acquisition reads `texture.texture` once and increments only that allocation

## File Manifest

| File                            | Purpose                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `gpu-pool.ts`                   | Side-effect-free facade preserving all existing exports                 |
| `texture-reference-store.ts`    | Shared lazily allocated `GPUTexture` reference-count `WeakMap`          |
| `texture-references.ts`         | Side-effect-free facade for `Texture2D` ownership operations            |
| `texture-acquire.ts`            | Captured-allocation facade acquisition                                  |
| `texture-release.ts`            | Captured-allocation facade release                                      |
| `gpu-texture-references.ts`     | Side-effect-free raw ownership facade                                   |
| `gpu-texture-acquire.ts`        | Shared allocation reference increment                                   |
| `gpu-texture-release.ts`        | Raw allocation release without facade notification                      |
| `texture-allocation-release.ts` | Shared decrement, destruction, notification ordering, and retained zero |
| `texture-owner-state.ts`        | Released-state and owner-count queries                                  |
| `sampler-pool.ts`               | Lazy per-device sampler cache, key construction, creation, and clear    |
| `gpu-buffers.ts`                | Side-effect-free facade for buffer creation utilities                   |
| `buffer-alignment.ts`           | Generic alignment operation                                             |
| `empty-uniform-buffer.ts`       | Empty aligned uniform-buffer allocation                                 |
| `uniform-buffer.ts`             | Initialized uniform-buffer allocation and upload rollback               |
| `mapped-buffer.ts`              | Mapped-at-creation buffer upload                                        |
