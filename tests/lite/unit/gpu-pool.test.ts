import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import {
    acquireGPUTexture,
    acquireTexture,
    clearSamplerCache,
    getOrCreateSampler,
    releaseGPUTexture,
    releaseTexture,
    _isTextureReleased,
    _setTextureReleaseHook,
    _textureOwners,
} from "../../../packages/babylon-lite/src/resource/gpu-pool";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import { getOrCreateSampler as getTextureSampler, type TextureSamplerDescriptor } from "../../../packages/babylon-lite/src/resource/texture-sampler-pool";

afterEach(() => _setTextureReleaseHook(() => undefined));

describe("shared GPU texture references", () => {
    it.each([false, true])("shares raw and facade counts while preserving release hooks (facade last: %s)", (facadeLast) => {
        const raw = { destroy: vi.fn() } as unknown as GPUTexture;
        const facade = { texture: raw } as Texture2D;
        const released = vi.fn(() => {
            expect(raw.destroy).toHaveBeenCalledOnce();
            expect(_textureOwners(facade)).toBe(1);
        });
        _setTextureReleaseHook(released);
        acquireTexture(facade);
        acquireGPUTexture(raw);
        expect(_textureOwners(facade)).toBe(2);
        expect(facadeLast ? releaseGPUTexture(raw) : releaseTexture(facade)).toBe(false);
        expect(released).not.toHaveBeenCalled();
        expect(facadeLast ? releaseTexture(facade) : releaseGPUTexture(raw)).toBe(true);
        expect(_textureOwners(facade)).toBe(0);
        expect(raw.destroy).toHaveBeenCalledOnce();
        expect(released).toHaveBeenCalledTimes(facadeLast ? 1 : 0);
    });

    it("preserves destroy, facade hook, then zero-count ordering", () => {
        const raw = { destroy: vi.fn() } as unknown as GPUTexture;
        const facade = { texture: raw } as Texture2D;
        acquireTexture(facade);
        _setTextureReleaseHook(() => {
            expect(raw.destroy).toHaveBeenCalledOnce();
            expect(_textureOwners(facade)).toBe(1);
            expect(_isTextureReleased(facade)).toBe(false);
        });

        expect(releaseTexture(facade)).toBe(true);
        expect(_textureOwners(facade)).toBe(0);
        expect(_isTextureReleased(facade)).toBe(true);
    });

    it("keeps absent-owner release behavior and never invokes the facade hook for raw release", () => {
        const released = vi.fn();
        _setTextureReleaseHook(released);
        const raw = { destroy: vi.fn() } as unknown as GPUTexture;
        const facade = { texture: raw } as Texture2D;

        expect(_textureOwners(facade)).toBe(0);
        expect(_isTextureReleased(facade)).toBe(false);
        expect(releaseGPUTexture(raw)).toBe(true);
        expect(raw.destroy).toHaveBeenCalledOnce();
        expect(released).not.toHaveBeenCalled();
        expect(_textureOwners(facade)).toBe(0);
        expect(_isTextureReleased(facade)).toBe(true);
    });

    it("preserves absent-owner facade release and its notification ordering", () => {
        const raw = { destroy: vi.fn() } as unknown as GPUTexture;
        const facade = { texture: raw } as Texture2D;
        const released = vi.fn(() => {
            expect(raw.destroy).toHaveBeenCalledOnce();
            expect(_isTextureReleased(facade)).toBe(false);
        });
        _setTextureReleaseHook(released);

        expect(releaseTexture(facade)).toBe(true);
        expect(released).toHaveBeenCalledOnce();
        expect(_isTextureReleased(facade)).toBe(true);
    });

    it("keeps release ownership on the captured allocation when the hook retargets the facade", () => {
        const oldAllocation = { destroy: vi.fn() } as unknown as GPUTexture;
        const replacement = { destroy: vi.fn() } as unknown as GPUTexture;
        const facade = { texture: oldAllocation } as Texture2D;
        const oldFacade = { texture: oldAllocation } as Texture2D;
        acquireTexture(facade);
        acquireGPUTexture(replacement);
        _setTextureReleaseHook((released) => {
            released.texture = replacement;
            expect(oldAllocation.destroy).toHaveBeenCalledOnce();
            expect(_textureOwners(oldFacade)).toBe(1);
            expect(_textureOwners(facade)).toBe(1);
        });

        expect(releaseTexture(facade)).toBe(true);
        expect(oldAllocation.destroy).toHaveBeenCalledOnce();
        expect(_textureOwners(oldFacade)).toBe(0);
        expect(_isTextureReleased(oldFacade)).toBe(true);
        expect(replacement.destroy).not.toHaveBeenCalled();
        expect(_textureOwners(facade)).toBe(1);
        expect(_isTextureReleased(facade)).toBe(false);
    });

    it("captures the facade allocation once when acquiring ownership", () => {
        const first = { destroy: vi.fn() } as unknown as GPUTexture;
        const second = { destroy: vi.fn() } as unknown as GPUTexture;
        let reads = 0;
        const facade = {
            get texture() {
                reads++;
                return reads === 1 ? first : second;
            },
        } as Texture2D;

        acquireTexture(facade);

        expect(reads).toBe(1);
        expect(_textureOwners({ texture: first } as Texture2D)).toBe(1);
        expect(_textureOwners({ texture: second } as Texture2D)).toBe(0);
    });
});

describe("sampler pool", () => {
    function engine(createSampler: ReturnType<typeof vi.fn>): EngineContext {
        const device = { createSampler } as unknown as GPUDevice;
        return { _device: device } as EngineContext;
    }

    it("shares default-behavior samplers across the texture and general boundaries", () => {
        const createSampler = vi.fn(() => ({}) as GPUSampler);
        const owner = engine(createSampler);
        const textureSampler = getTextureSampler(owner, { minFilter: "linear" });
        const generalSampler = getOrCreateSampler(owner, { minFilter: "linear", lodMinClamp: 0, lodMaxClamp: 32 });
        expect(generalSampler).toBe(textureSampler);
        expect(getOrCreateSampler(owner, { minFilter: "linear", compare: "less" })).not.toBe(textureSampler);
        expect(getOrCreateSampler(owner, { minFilter: "linear", lodMaxClamp: 0 })).not.toBe(textureSampler);
        expect(createSampler).toHaveBeenCalledTimes(3);
        clearSamplerCache(owner);
        expect(getTextureSampler(owner, { minFilter: "linear" })).not.toBe(textureSampler);
    });

    it("prevents comparison and LOD overrides from entering the restricted texture boundary", () => {
        expectTypeOf<{ compare: "less" }>().not.toExtend<TextureSamplerDescriptor>();
        expectTypeOf<{ lodMinClamp: 0 }>().not.toExtend<TextureSamplerDescriptor>();
        expectTypeOf<{ lodMaxClamp: 32 }>().not.toExtend<TextureSamplerDescriptor>();
        expectTypeOf<GPUSamplerDescriptor>().not.toExtend<TextureSamplerDescriptor>();
    });

    it("deduplicates equivalent descriptors without rewriting the creation descriptor", () => {
        const created = { id: 1 } as unknown as GPUSampler;
        const createSampler = vi.fn(() => created);
        const owner = engine(createSampler);
        const descriptor: GPUSamplerDescriptor = { minFilter: "linear", lodMaxClamp: 3 };

        expect(getOrCreateSampler(owner, descriptor)).toBe(created);
        expect(getOrCreateSampler(owner, { minFilter: "linear", lodMaxClamp: 3, lodMinClamp: 0 })).toBe(created);
        expect(createSampler).toHaveBeenCalledOnce();
        expect(createSampler).toHaveBeenCalledWith(descriptor);
    });

    it.each([
        [{}, { compare: "less" }],
        [{ compare: "less" }, { compare: "greater" }],
        [{}, { lodMinClamp: 1 }],
        [{}, { lodMaxClamp: 0 }],
        [{ lodMaxClamp: 3 }, { lodMaxClamp: 9 }],
    ] satisfies [GPUSamplerDescriptor, GPUSamplerDescriptor][])("keeps comparison and LOD behavior separate: %j vs %j", (first, second) => {
        const createSampler = vi.fn(() => ({}) as GPUSampler);
        const owner = engine(createSampler);
        const a = getOrCreateSampler(owner, first);
        const b = getOrCreateSampler(owner, second);

        expect(a).not.toBe(b);
        expect(getOrCreateSampler(owner, { ...first })).toBe(a);
        expect(getOrCreateSampler(owner, { ...second })).toBe(b);
        expect(createSampler).toHaveBeenCalledTimes(2);
    });

    it("normalizes omitted WebGPU defaults while ignoring labels", () => {
        const createSampler = vi.fn(() => ({}) as GPUSampler);
        const owner = engine(createSampler);
        const sampler = getOrCreateSampler(owner);

        expect(
            getOrCreateSampler(owner, {
                label: "same behavior",
                minFilter: "nearest",
                magFilter: "nearest",
                mipmapFilter: "nearest",
                addressModeU: "clamp-to-edge",
                addressModeV: "clamp-to-edge",
                addressModeW: "clamp-to-edge",
                lodMinClamp: 0,
                lodMaxClamp: 32,
                maxAnisotropy: 1,
            })
        ).toBe(sampler);
        expect(createSampler).toHaveBeenCalledOnce();
    });

    it("keeps caches device-local and clearable", () => {
        const createSamplerA = vi.fn(() => ({ id: "a" }) as unknown as GPUSampler);
        const createSamplerB = vi.fn(() => ({ id: "b" }) as unknown as GPUSampler);
        const ownerA = engine(createSamplerA);
        const ownerB = engine(createSamplerB);

        expect(getOrCreateSampler(ownerA)).not.toBe(getOrCreateSampler(ownerB));
        expect(getOrCreateSampler(ownerA, { minFilter: "nearest" })).toBe(getOrCreateSampler(ownerA));
        clearSamplerCache(ownerA);
        getOrCreateSampler(ownerA);
        expect(createSamplerA).toHaveBeenCalledTimes(2);
        expect(createSamplerB).toHaveBeenCalledOnce();
    });
});
