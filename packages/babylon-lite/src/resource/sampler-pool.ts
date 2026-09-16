import type { EngineContext } from "../engine/engine.js";

let _samplerCache: WeakMap<GPUDevice, Map<string, GPUSampler>> | null = null;

function samplerKey(descriptor: GPUSamplerDescriptor): string {
    return `${descriptor.minFilter ?? "nearest"}:${descriptor.magFilter ?? "nearest"}:${descriptor.mipmapFilter ?? "nearest"}:${descriptor.addressModeU ?? "clamp-to-edge"}:${descriptor.addressModeV ?? "clamp-to-edge"}:${descriptor.addressModeW ?? "clamp-to-edge"}:${descriptor.maxAnisotropy ?? 1}`;
}

/** Get or create a deduplicated sampler. Same pooled config returns the same sampler. */
export function getOrCreateSampler(engine: EngineContext, descriptor: GPUSamplerDescriptor = {}): GPUSampler {
    const device = engine._device;
    const samplerCache = (_samplerCache ??= new WeakMap());
    let deviceCache = samplerCache.get(device);
    if (!deviceCache) {
        deviceCache = new Map();
        samplerCache.set(device, deviceCache);
    }
    const key = samplerKey(descriptor);
    let sampler = deviceCache.get(key);
    if (!sampler) {
        sampler = device.createSampler(descriptor);
        deviceCache.set(key, sampler);
    }
    return sampler;
}

/** Clear sampler cache for one device. */
export function clearSamplerCache(engine: EngineContext): void {
    _samplerCache?.delete(engine._device);
}
