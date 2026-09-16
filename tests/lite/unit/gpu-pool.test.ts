import { afterEach, describe, expect, it, vi } from "vitest";
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

    it("deduplicates the existing key fields without rewriting the creation descriptor", () => {
        const created = { id: 1 } as unknown as GPUSampler;
        const createSampler = vi.fn(() => created);
        const owner = engine(createSampler);
        const descriptor: GPUSamplerDescriptor = { minFilter: "linear", lodMaxClamp: 3 };

        expect(getOrCreateSampler(owner, descriptor)).toBe(created);
        expect(getOrCreateSampler(owner, { minFilter: "linear", lodMaxClamp: 9 })).toBe(created);
        expect(createSampler).toHaveBeenCalledOnce();
        expect(createSampler).toHaveBeenCalledWith(descriptor);
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
