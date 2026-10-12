import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { makeSamplerFor } from "../../../packages/babylon-lite/src/loader-gltf/gltf-sampler-desc";
import { getOrCreateSampler } from "../../../packages/babylon-lite/src/resource/sampler-pool";

describe("glTF sampler pooling", () => {
    it("reuses non-mipmap samplers without aliasing an otherwise identical full-LOD sampler", () => {
        const createSampler = vi.fn(() => ({}) as GPUSampler);
        const engine = { _device: { createSampler } } as unknown as EngineContext;
        const descriptor: GPUSamplerDescriptor = {
            minFilter: "linear",
            magFilter: "linear",
            mipmapFilter: "linear",
            addressModeU: "repeat",
            addressModeV: "repeat",
            maxAnisotropy: 1,
        };
        const defaultSampler = getOrCreateSampler(engine, descriptor);
        const samplerFor = makeSamplerFor(engine, { textures: [{ sampler: 0 }], samplers: [{ minFilter: 9729 }] }, defaultSampler);
        const noMip = samplerFor({ index: 0 });

        expect(noMip).not.toBe(defaultSampler);
        expect(samplerFor({ index: 0 })).toBe(noMip);
        expect(samplerFor(null)).toBe(defaultSampler);
        expect(getOrCreateSampler(engine, descriptor)).toBe(defaultSampler);
        expect(createSampler).toHaveBeenCalledTimes(2);
        expect(createSampler).toHaveBeenLastCalledWith({ ...descriptor, lodMaxClamp: 0 });
    });
});
