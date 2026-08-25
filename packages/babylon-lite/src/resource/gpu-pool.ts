/**
 * GPU Resource Pool — ref-counted textures + deduplicated samplers.
 *
 * Texture ref counting: acquire increments, release decrements.
 * When count hits 0 the GPUTexture is destroyed.
 *
 * Sampler pool: identical descriptors return the same GPUSampler.
 */

import type { EngineContext } from "../engine/engine.js";
import type { Texture2D } from "../texture/texture-2d.js";

// ── Texture ref counting ─────────────────────────────────────

let _texRefs: WeakMap<GPUTexture, number> | null = null;

function texRefs(): WeakMap<GPUTexture, number> {
    if (!_texRefs) {
        _texRefs = new WeakMap();
    }
    return _texRefs;
}

/** Increment ref count on a Texture2D. First acquire sets count to 1. */
export function acquireTexture(tex: Texture2D): void {
    const m = texRefs();
    m.set(tex.texture, (m.get(tex.texture) ?? 0) + 1);
}

/**
 * Decrement ref count on a Texture2D.
 * Calls `tex.texture.destroy()` when count reaches 0.
 * Returns true if the texture was destroyed.
 */
export function releaseTexture(tex: Texture2D): boolean {
    const m = texRefs();
    const c = (m.get(tex.texture) ?? 1) - 1;
    if (c <= 0) {
        tex.texture.destroy();
        // Zero is kept rather than deleted so a destroyed texture stays distinguishable from one
        // nothing ever took ownership of, which has no entry at all. `_isTextureReleased` reads
        // that difference; the key is weak either way, so the entry retains nothing.
        m.set(tex.texture, 0);
        return true;
    }
    m.set(tex.texture, c);
    return false;
}

/** True once every owner has released a Texture2D's current GPUTexture and `releaseTexture`
 *  destroyed it. False both while the texture is owned and when nothing ever took ownership of it —
 *  `createSolidTexture2D` and the glTF upload path take no reference, so their textures have no
 *  entry until a consumer acquires one.
 *
 *  Read by device-lost recovery to tell a texture the application still uses from one it has
 *  finished with. It lives here as a read rather than a flag written onto the wrapper by
 *  `releaseTexture` so scenes that never enable recovery carry none of the bookkeeping.
 *  @internal */
export function _isTextureReleased(tex: Texture2D): boolean {
    return texRefs().get(tex.texture) === 0;
}

/** Increment ref count on a raw GPUTexture (for env textures). */
export function acquireGPUTexture(tex: GPUTexture): void {
    const m = texRefs();
    m.set(tex, (m.get(tex) ?? 0) + 1);
}

/** Decrement ref count on a raw GPUTexture. Destroys at 0. */
export function releaseGPUTexture(tex: GPUTexture): boolean {
    const m = texRefs();
    const c = (m.get(tex) ?? 1) - 1;
    if (c <= 0) {
        tex.destroy();
        m.set(tex, 0);
        return true;
    }
    m.set(tex, c);
    return false;
}

// ── Sampler deduplication ────────────────────────────────────

let _samplerCache: WeakMap<GPUDevice, Map<string, GPUSampler>> | null = null;

function samplerKey(desc: GPUSamplerDescriptor): string {
    return `${desc.minFilter ?? "nearest"}:${desc.magFilter ?? "nearest"}:${desc.mipmapFilter ?? "nearest"}:${desc.addressModeU ?? "clamp-to-edge"}:${desc.addressModeV ?? "clamp-to-edge"}:${desc.addressModeW ?? "clamp-to-edge"}:${desc.maxAnisotropy ?? 1}`;
}

/** Get or create a deduplicated sampler. Same config → same GPUSampler. */
export function getOrCreateSampler(engine: EngineContext, desc: GPUSamplerDescriptor = {}): GPUSampler {
    const device = engine._device;
    if (!_samplerCache) {
        _samplerCache = new WeakMap();
    }
    let dc = _samplerCache.get(device);
    if (!dc) {
        dc = new Map();
        _samplerCache.set(device, dc);
    }
    const key = samplerKey(desc);
    let s = dc.get(key);
    if (!s) {
        s = device.createSampler(desc);
        dc.set(key, s);
    }
    return s;
}

/** Clear sampler cache for a device. */
export function clearSamplerCache(engine: EngineContext): void {
    const device = engine._device;
    _samplerCache?.delete(device);
}
