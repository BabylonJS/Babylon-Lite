import { describe, expect, it, vi } from "vitest";
import { createTexture2DFromExternalImage } from "../../../packages/babylon-lite/src/texture/external-image-texture";
import { releaseTexture } from "../../../packages/babylon-lite/src/resource/gpu-pool";
import { rebuildTexture2D } from "../../../packages/babylon-lite/src/texture/texture-recovery";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";

interface Captured {
    createDescs: GPUTextureDescriptor[];
    samplerDesc?: GPUSamplerDescriptor;
    copies: Array<{ source: GPUCopyExternalImageSourceInfo; destination: GPUCopyExternalImageDestInfo; size: GPUExtent3DStrict }>;
    destroyed: number;
}

function fakeSource(width = 8, height = 4): ImageBitmap {
    return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

function makeEngine(captured: Captured, options: { copyError?: Error; gpuError?: GPUError; gpuErrors?: GPUError[]; textureMipLevelCount?: number } = {}): EngineContext {
    const errorScopes: Array<{ filter: GPUErrorFilter; error: GPUError | null }> = [];
    const device = {
        pushErrorScope: (filter: GPUErrorFilter) => {
            errorScopes.push({ filter, error: null });
        },
        popErrorScope: () => Promise.resolve(errorScopes.pop()?.error ?? null),
        createTexture: (descriptor: GPUTextureDescriptor) => {
            captured.createDescs.push(descriptor);
            return {
                mipLevelCount: options.textureMipLevelCount ?? descriptor.mipLevelCount ?? 1,
                createView: () => ({ kind: "view" }),
                destroy: () => captured.destroyed++,
            } as unknown as GPUTexture;
        },
        createCommandEncoder: () => ({ finish: () => ({}) }),
        createSampler: (descriptor: GPUSamplerDescriptor) => {
            captured.samplerDesc = descriptor;
            return { kind: "sampler" } as unknown as GPUSampler;
        },
        queue: {
            submit: () => undefined,
            copyExternalImageToTexture: (source: GPUCopyExternalImageSourceInfo, destination: GPUCopyExternalImageDestInfo, size: GPUExtent3DStrict) => {
                if (options.copyError) {
                    throw options.copyError;
                }
                captured.copies.push({ source, destination, size });
                const gpuError = options.gpuErrors?.shift() ?? options.gpuError;
                if (gpuError) {
                    for (let index = errorScopes.length - 1; index >= 0; index--) {
                        const scope = errorScopes[index]!;
                        if (scope.filter === "validation") {
                            scope.error = gpuError;
                            break;
                        }
                    }
                }
            },
        },
    };
    return { _device: device as unknown as GPUDevice } as unknown as EngineContext;
}

function newCaptured(): Captured {
    return { createDescs: [], copies: [], destroyed: 0 };
}

describe("createTexture2DFromExternalImage", () => {
    it("creates a distinct caller-owned texture on every invocation", async () => {
        const captured = newCaptured();
        const engine = makeEngine(captured);
        const source = fakeSource();

        const first = await createTexture2DFromExternalImage(engine, source, { mipMaps: false });
        const second = await createTexture2DFromExternalImage(engine, source, { mipMaps: false });

        expect(captured.createDescs).toHaveLength(2);
        expect(first.texture).not.toBe(second.texture);
        expect(releaseTexture(first)).toBe(true);
        expect(captured.destroyed).toBe(1);
        expect(releaseTexture(second)).toBe(true);
        expect(captured.destroyed).toBe(2);
        expect(source.close).not.toHaveBeenCalled();
    });

    it("uploads directly with explicit Y inversion and sampler options", async () => {
        const captured = newCaptured();
        const source = fakeSource(16, 8);
        const texture = await createTexture2DFromExternalImage(makeEngine(captured), source, {
            mipMaps: false,
            invertY: false,
            premultiplyAlpha: true,
            srgb: true,
            addressModeU: "clamp-to-edge",
            minFilter: "nearest",
        });

        expect(texture.width).toBe(16);
        expect(texture.height).toBe(8);
        expect(captured.createDescs[0]).toMatchObject({ size: { width: 16, height: 8 }, format: "rgba8unorm-srgb", mipLevelCount: 1 });
        expect(captured.copies).toHaveLength(1);
        expect(captured.copies[0]!.source).toMatchObject({ source, flipY: false });
        expect(captured.copies[0]!.destination.premultipliedAlpha).toBe(true);
        expect(captured.copies[0]!.size).toEqual({ width: 16, height: 8 });
        expect(captured.samplerDesc).toMatchObject({ addressModeU: "clamp-to-edge", minFilter: "nearest", mipmapFilter: "nearest", maxAnisotropy: 1 });
        expect(source.close).not.toHaveBeenCalled();
    });

    it("downscales the larger dimension while preserving aspect ratio", async () => {
        const captured = newCaptured();
        const source = fakeSource(4000, 2000);
        const resized = fakeSource(1000, 500);
        const createBitmap = vi.fn().mockResolvedValue(resized);
        vi.stubGlobal("createImageBitmap", createBitmap);

        try {
            const texture = await createTexture2DFromExternalImage(makeEngine(captured), source, { maxDimension: 1000, mipMaps: false });

            expect(createBitmap).toHaveBeenCalledWith(source, {
                resizeWidth: 1000,
                resizeHeight: 500,
                resizeQuality: "high",
                premultiplyAlpha: "none",
                colorSpaceConversion: "none",
            });
            expect(texture.width).toBe(1000);
            expect(texture.height).toBe(500);
            expect(captured.copies[0]!.source.source).toBe(resized);
            expect(resized.close).toHaveBeenCalledOnce();
            expect(source.close).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("does not upscale or allocate an intermediate bitmap", async () => {
        const captured = newCaptured();
        const source = fakeSource(64, 32);
        const createBitmap = vi.fn();
        vi.stubGlobal("createImageBitmap", createBitmap);

        try {
            await createTexture2DFromExternalImage(makeEngine(captured), source, { maxDimension: 128, mipMaps: false });
            expect(createBitmap).not.toHaveBeenCalled();
            expect(captured.copies[0]!.source.source).toBe(source);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("recognizes intrinsic dimensions without DOM constructor checks", async () => {
        const captured = newCaptured();
        const videoFrameShape = { displayWidth: 320, displayHeight: 180 } as unknown as GPUCopyExternalImageSource;

        const texture = await createTexture2DFromExternalImage(makeEngine(captured), videoFrameShape, { mipMaps: false });

        expect(texture.width).toBe(320);
        expect(texture.height).toBe(180);
        expect(captured.createDescs[0]!.size).toEqual({ width: 320, height: 180 });
    });

    it("rejects unsupported sources and invalid maximum dimensions before allocation", async () => {
        const captured = newCaptured();
        const engine = makeEngine(captured);

        await expect(createTexture2DFromExternalImage(engine, {} as GPUCopyExternalImageSource)).rejects.toThrow(/intrinsic dimensions/);
        await expect(createTexture2DFromExternalImage(engine, fakeSource(), { maxDimension: 0 })).rejects.toThrow(/positive integer/);
        expect(captured.createDescs).toHaveLength(0);
    });

    it("propagates resize failures without creating a texture", async () => {
        const captured = newCaptured();
        const failure = new DOMException("decode failed", "InvalidStateError");
        vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(failure));

        try {
            await expect(createTexture2DFromExternalImage(makeEngine(captured), fakeSource(100, 50), { maxDimension: 10 })).rejects.toBe(failure);
            expect(captured.createDescs).toHaveLength(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("propagates upload failures, destroys the partial texture, and closes only a resized bitmap", async () => {
        const captured = newCaptured();
        const source = fakeSource(100, 50);
        const resized = fakeSource(10, 5);
        const failure = new DOMException("source is detached", "InvalidStateError");
        vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(resized));

        try {
            await expect(createTexture2DFromExternalImage(makeEngine(captured, { copyError: failure }), source, { maxDimension: 10, mipMaps: false })).rejects.toBe(failure);
            expect(captured.destroyed).toBe(1);
            expect(resized.close).toHaveBeenCalledOnce();
            expect(source.close).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("surfaces scoped WebGPU validation failures and destroys the partial texture", async () => {
        const captured = newCaptured();
        const gpuError = { message: "external source is invalid" } as GPUError;

        await expect(createTexture2DFromExternalImage(makeEngine(captured, { gpuError }), fakeSource(), { mipMaps: false })).rejects.toThrow(
            /GPU upload failed: external source is invalid/
        );
        expect(captured.destroyed).toBe(1);
    });

    it("keeps concurrent mipmapped uploads in their own WebGPU error scopes", async () => {
        const captured = newCaptured();
        const firstError = { message: "first upload failed" } as GPUError;
        const secondError = { message: "second upload failed" } as GPUError;
        const engine = makeEngine(captured, { gpuErrors: [firstError, secondError], textureMipLevelCount: 1 });

        const [first, second] = await Promise.allSettled([createTexture2DFromExternalImage(engine, fakeSource(2, 1)), createTexture2DFromExternalImage(engine, fakeSource(2, 1))]);

        expect(first.status).toBe("rejected");
        expect(second.status).toBe("rejected");
        expect((first as PromiseRejectedResult).reason.cause).toBe(firstError);
        expect((second as PromiseRejectedResult).reason.cause).toBe(secondError);
        expect(captured.destroyed).toBe(2);
    });

    it("retains and releases a factory-owned image for device-lost recovery", async () => {
        const captured = newCaptured();
        const engine = makeEngine(captured, { textureMipLevelCount: 1 });
        const source = fakeSource(16, 8);
        const owned = fakeSource(16, 8);
        vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(owned));
        (engine as unknown as { _dlr: { t: (texture: { _recoverySource?: unknown }, recovery: unknown) => void } })._dlr = {
            t(texture, recovery): void {
                texture._recoverySource = recovery;
            },
        };

        try {
            const texture = await createTexture2DFromExternalImage(engine, source, {
                invertY: false,
                premultiplyAlpha: true,
                srgb: true,
                addressModeU: "clamp-to-edge",
                minFilter: "nearest",
            });
            source.close();

            const rebuilt = newCaptured();
            engine._device = makeEngine(rebuilt, { textureMipLevelCount: 1 })._device;
            await rebuildTexture2D(engine, texture);

            expect(rebuilt.createDescs[0]).toMatchObject({ size: { width: 16, height: 8 }, format: "rgba8unorm-srgb", mipLevelCount: 5 });
            expect(rebuilt.copies[0]!.source).toMatchObject({ source: owned, flipY: false });
            expect(rebuilt.copies[0]!.destination.premultipliedAlpha).toBe(true);
            expect(rebuilt.samplerDesc).toMatchObject({ addressModeU: "clamp-to-edge", minFilter: "nearest", mipmapFilter: "linear" });
            expect(owned.close).not.toHaveBeenCalled();

            expect(releaseTexture(texture)).toBe(true);
            expect(owned.close).toHaveBeenCalledOnce();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
