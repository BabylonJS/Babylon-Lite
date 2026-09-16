import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { disposeGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import { buildRenderTarget, disposeRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { acquireTexture, releaseTexture, _textureOwners } from "../../../packages/babylon-lite/src/resource/gpu-pool";
import { disposeRenderTargetTexture } from "../../../packages/babylon-lite/src/texture/rtt";
import { createSurfaceRenderTargetTexture, onRenderTargetTextureResize } from "../../../packages/babylon-lite/src/texture/rtt-surface";
import { withSampledDepthTexture } from "../../../packages/babylon-lite/src/texture/rtt-depth";
import { cloneTexture2D, type Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

const gpuGlobals = globalThis as unknown as Omit<typeof globalThis, "GPUTextureUsage"> & {
    GPUTextureUsage?: Record<string, number>;
};
gpuGlobals.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 8 };

function makeEngine(): EngineContext {
    const device = {
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
            const texture = {
                format: descriptor.format,
                sampleCount: descriptor.sampleCount ?? 1,
                createView: vi.fn((viewDescriptor?: GPUTextureViewDescriptor) => ({ texture, viewDescriptor }) as unknown as GPUTextureView),
                destroy: vi.fn(),
            };
            return texture as unknown as GPUTexture;
        }),
        createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => descriptor as unknown as GPUSampler),
    } as unknown as GPUDevice;
    const engine = {
        _device: device,
        canvas: { width: 64, height: 32 },
        _renderingContexts: [],
    } as unknown as EngineContext;
    Object.assign(engine, { engine });
    return engine;
}

describe("createSurfaceRenderTargetTexture", () => {
    it("rejects depth-only targets without the explicit helper before allocating", () => {
        const engine = makeEngine();
        expect(() => createSurfaceRenderTargetTexture(engine, { dFormat: "depth32float", samples: 1, size: engine })).toThrow(/Depth-only.*withSampledDepthTexture/);
        expect(engine._device.createTexture).not.toHaveBeenCalled();
    });

    it("replaces and releases unsampled depth without creating a depth facade", () => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: engine });
        const oldDepth = result.rt._depthTexture!;
        engine.canvas.width = 128;
        buildRenderTarget(result.rt, engine);
        const replacement = result.rt._depthTexture!;
        expect(replacement).not.toBe(oldDepth);
        expect(result.depthTexture).toBeNull();
        expect(replacement.createView).toHaveBeenCalledOnce();
        expect(oldDepth.destroy).not.toHaveBeenCalled();
        disposeGpuResourceRetirements(engine);
        expect(oldDepth.destroy).toHaveBeenCalledOnce();
        expect(replacement.destroy).not.toHaveBeenCalled();
        disposeRenderTargetTexture(result);
        expect(replacement.destroy).toHaveBeenCalledOnce();
    });

    it.each(["color", "depth", "depth-only"] as const)("keeps %s clones on the current allocation across repeated resizes", (kind) => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(
            engine,
            {
                format: kind === "depth-only" ? undefined : "rgba8unorm",
                dFormat: "depth32float",
                samples: 1,
                size: engine,
            },
            withSampledDepthTexture
        );
        const base = kind === "color" ? result.texture : result.depthTexture!;
        if (kind === "depth-only") {
            expect(result.texture).toBe(result.depthTexture);
        }
        const first = cloneTexture2D(base, { uScale: 2, uOffset: 0.25 });
        const nested = cloneTexture2D(first, { uScale: 3, vOffset: 0.5 });
        const unowned = cloneTexture2D(nested, { vScale: 4 });
        acquireTexture(base);
        acquireTexture(first);
        acquireTexture(nested);
        const resized = vi.fn(() => {
            for (const clone of [first, nested, unowned]) {
                expect(clone.texture).toBe(base.texture);
                expect(clone.view).toBe(base.view);
                expect(clone.width).toBe(engine.canvas.width);
                expect(clone.height).toBe(engine.canvas.height);
            }
        });
        onRenderTargetTextureResize(result, resized);
        for (let index = 0; index < 3; index++) {
            const old = base.texture;
            engine.canvas.width += 8;
            engine.canvas.height += 4;
            buildRenderTarget(result.rt, engine);
            expect(_textureOwners(nested)).toBe(index === 0 ? 4 : 3);
            if (index === 0) {
                releaseTexture(first);
            }
            disposeGpuResourceRetirements(engine);
            expect(old.destroy).toHaveBeenCalledOnce();
        }
        expect(resized).toHaveBeenCalledTimes(3);
        first.uScale = 5;
        base.uOffset = 0.75;
        expect(nested.uScale).toBe(3);
        expect(nested.uOffset).toBe(0.25);
        expect(first.uOffset).toBe(0.25);
        expect(base.uScale).toBeUndefined();
        expect(unowned.vScale).toBe(4);
        const current = nested.texture;
        disposeRenderTargetTexture(result);
        expect(current.destroy).not.toHaveBeenCalled();
        releaseTexture(base);
        releaseTexture(nested);
        expect(current.destroy).toHaveBeenCalledOnce();
        expect(_textureOwners(nested)).toBe(0);
    });

    it("keeps all clone generations unchanged when replacement allocation fails", () => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: engine }, withSampledDepthTexture);
        const clone = cloneTexture2D(result.texture, { uScale: 2 });
        acquireTexture(clone);
        const old = clone.texture;
        const view = clone.view;
        const width = clone.width;
        vi.mocked(engine._device.createTexture).mockImplementationOnce(() => {
            throw new Error("allocation failed");
        });
        engine.canvas.width += 4;
        expect(() => buildRenderTarget(result.rt, engine)).toThrow("allocation failed");
        expect(clone.texture).toBe(old);
        expect(clone.view).toBe(view);
        expect(clone.width).toBe(width);
        expect(_textureOwners(clone)).toBe(2);
        buildRenderTarget(result.rt, engine);
        expect(clone.texture).toBe(result.texture.texture);
        expect(clone.texture).not.toBe(old);
        disposeGpuResourceRetirements(engine);
        disposeRenderTargetTexture(result);
        releaseTexture(clone);
        expect(old.destroy).toHaveBeenCalledOnce();
    });

    it("retains snapshot behavior for ordinary texture clones after surface RTT support is installed", () => {
        const engine = makeEngine();
        const rtt = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: engine });
        const gpu = engine._device.createTexture({ size: [4, 4], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING });
        const base: Texture2D = { texture: gpu, view: gpu.createView(), sampler: engine._device.createSampler(), width: 4, height: 4 };
        const clone = cloneTexture2D(base, { uScale: 2 });
        const view = clone.view;
        base.texture = rtt.texture.texture;
        base.view = rtt.texture.view;
        base.width = 64;
        expect(clone.texture).toBe(gpu);
        expect(clone.view).toBe(view);
        expect(clone.width).toBe(4);
        disposeRenderTargetTexture(rtt);
        gpu.destroy();
    });

    it("resizes a depth-only target while preserving sampled facade identity", () => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(
            engine,
            {
                dFormat: "depth32float",
                samples: 1,
                size: engine,
            },
            withSampledDepthTexture
        );
        const facade = result.depthTexture!;
        const oldTexture = facade.texture;
        const resized = vi.fn();
        onRenderTargetTextureResize(result, resized);
        acquireTexture(facade);
        engine.canvas.width = 128;
        engine.canvas.height = 96;

        buildRenderTarget(result.rt, engine);

        expect(result.texture).toBe(facade);
        expect(result.depthTexture).toBe(facade);
        expect(facade.texture).not.toBe(oldTexture);
        expect(facade.width).toBe(128);
        expect(facade.height).toBe(96);
        expect(resized).toHaveBeenCalledOnce();
        expect(oldTexture.destroy as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
        disposeGpuResourceRetirements(engine);
        expect(oldTexture.destroy as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();

        const resizedTexture = facade.texture;
        engine._device = makeEngine()._device;
        buildRenderTarget(result.rt, engine);
        expect(facade.texture).not.toBe(resizedTexture);
        expect(resized).toHaveBeenCalledTimes(2);
    });

    it("transfers writer and sampler references across repeated resizes and final disposal", () => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: engine }, withSampledDepthTexture);
        acquireTexture(result.depthTexture!);
        for (let index = 0; index < 3; index++) {
            const oldColor = result.texture.texture;
            const oldDepth = result.depthTexture!.texture;
            engine.canvas.width += 8;
            buildRenderTarget(result.rt, engine);
            expect(_textureOwners(result.texture)).toBe(1);
            expect(_textureOwners(result.depthTexture!)).toBe(2);
            disposeGpuResourceRetirements(engine);
            expect(oldColor.destroy).toHaveBeenCalledOnce();
            expect(oldDepth.destroy).toHaveBeenCalledOnce();
        }
        disposeRenderTarget(result.rt);
        expect(result.texture.texture.destroy).toHaveBeenCalledOnce();
        expect(result.depthTexture!.texture.destroy).not.toHaveBeenCalled();
        releaseTexture(result.depthTexture!);
        expect(result.depthTexture!.texture.destroy).toHaveBeenCalledOnce();
    });

    it("preserves the old target and references if replacement allocation fails", () => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: engine }, withSampledDepthTexture);
        const oldColor = result.texture.texture;
        const oldDepth = result.depthTexture!.texture;
        const createTexture = vi.mocked(engine._device.createTexture);
        const allocate = createTexture.getMockImplementation()!;
        createTexture.mockImplementationOnce(allocate).mockImplementationOnce(() => {
            throw new Error("depth allocation failed");
        });
        engine.canvas.width += 8;
        expect(() => buildRenderTarget(result.rt, engine)).toThrow("depth allocation failed");
        expect(result.rt._colorTexture).toBe(oldColor);
        expect(result.rt._depthTexture).toBe(oldDepth);
        expect(_textureOwners(result.texture)).toBe(1);
        expect(_textureOwners(result.depthTexture!)).toBe(1);
        expect(oldColor.destroy).not.toHaveBeenCalled();
        expect(oldDepth.destroy).not.toHaveBeenCalled();
        expect((createTexture.mock.results[2]!.value as GPUTexture).destroy).toHaveBeenCalledOnce();
        buildRenderTarget(result.rt, engine);
        disposeGpuResourceRetirements(engine);
        disposeRenderTargetTexture(result);
    });

    it("cleans base ownership and preserves errors when surface setup fails", () => {
        const engine = makeEngine();
        const createTexture = vi.mocked(engine._device.createTexture);
        const allocate = createTexture.getMockImplementation()!;
        createTexture.mockImplementationOnce((descriptor) => {
            const texture = allocate(descriptor);
            vi.mocked(texture.destroy).mockImplementation(() => {
                throw new Error("cleanup failed");
            });
            return texture;
        });
        let sizeReads = 0;
        const descriptor = {
            format: "rgba8unorm" as GPUTextureFormat,
            samples: 1,
            get size() {
                if (sizeReads++ === 0) {
                    return engine;
                }
                throw new Error("surface setup failed");
            },
        };
        expect(() => createSurfaceRenderTargetTexture(engine, descriptor)).toThrow("surface setup failed");
        expect((createTexture.mock.results[0]!.value as GPUTexture).destroy).toHaveBeenCalledOnce();
    });

    it("supports callback unregistration and rejects registration after disposal", () => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: engine });
        const callback = vi.fn();
        const unregister = onRenderTargetTextureResize(result, callback);
        unregister();
        unregister();
        engine.canvas.width += 8;
        buildRenderTarget(result.rt, engine);
        expect(callback).not.toHaveBeenCalled();
        disposeGpuResourceRetirements(engine);
        disposeRenderTargetTexture(result);
        expect(() => onRenderTargetTextureResize(result, callback)).toThrow(/disposed/);
        expect(() => buildRenderTarget(result.rt, engine)).toThrow(/disposed/);
    });
});
