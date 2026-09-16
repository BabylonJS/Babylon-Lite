import type { EngineContext } from "../engine/engine.js";

/** @internal Samplers constructed by texture loaders without comparison or LOD overrides. */
export type TextureSamplerDescriptor = Omit<GPUSamplerDescriptor, "compare" | "lodMinClamp" | "lodMaxClamp"> & {
    compare?: never;
    lodMinClamp?: never;
    lodMaxClamp?: never;
};

let samplerCaches: WeakMap<GPUDevice, Map<string, GPUSampler>> | null = null;

const defaultFilter = "nearest";
const defaultAddressMode = "clamp-to-edge";
const textureSamplerDefaults = {
    minFilter: defaultFilter,
    magFilter: defaultFilter,
    mipmapFilter: defaultFilter,
    addressModeU: defaultAddressMode,
    addressModeV: defaultAddressMode,
    addressModeW: defaultAddressMode,
    maxAnisotropy: 1,
} as const satisfies Record<keyof Omit<GPUSamplerDescriptor, "label" | "compare" | "lodMinClamp" | "lodMaxClamp">, string | number>;

/** @internal Pool a texture sampler; the general API supplies a canonical key for extra behavior. */
export function getOrCreateSampler(engine: EngineContext, descriptor?: TextureSamplerDescriptor): GPUSampler;
/** @internal Only the general sampler boundary supplies normalized comparison/LOD identity. */
export function getOrCreateSampler(engine: EngineContext, descriptor: GPUSamplerDescriptor, extraKey: string): GPUSampler;
export function getOrCreateSampler(engine: EngineContext, descriptor: GPUSamplerDescriptor = {}, extraKey = ""): GPUSampler {
    const device = engine._device;
    const caches = (samplerCaches ??= new WeakMap());
    let cache = caches.get(device);
    if (!cache) {
        cache = new Map();
        caches.set(device, cache);
    }
    let key = extraKey;
    for (const property in textureSamplerDefaults) {
        const field = property as keyof typeof textureSamplerDefaults;
        key += `:${descriptor[field] ?? textureSamplerDefaults[field]}`;
    }
    let sampler = cache.get(key);
    if (!sampler) {
        sampler = device.createSampler(descriptor);
        cache.set(key, sampler);
    }
    return sampler;
}

/** Clear sampler cache for one device. */
export function clearSamplerCache(engine: EngineContext): void {
    samplerCaches?.delete(engine._device);
}
