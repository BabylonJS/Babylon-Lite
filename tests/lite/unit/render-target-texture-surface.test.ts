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
        queue: { onSubmittedWorkDone: vi.fn(async (): Promise<undefined> => undefined) },
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
    it("tracks scaled live surface dimensions with floor rounding and a one-pixel minimum", () => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(engine, {
            format: "rgba8unorm",
            samples: 1,
            size: { surface: engine, scale: 0.5 },
        });
        expect(result.texture.width).toBe(32);
        expect(result.texture.height).toBe(16);
        const resized = vi.fn();
        onRenderTargetTextureResize(result, resized);

        engine.canvas.width = 65;
        engine.canvas.height = 3;
        buildRenderTarget(result.rt, engine);

        expect(result.texture.width).toBe(32);
        expect(result.texture.height).toBe(1);
        expect(resized).toHaveBeenCalledOnce();
        disposeGpuResourceRetirements(engine);
        disposeRenderTargetTexture(result);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid surface scale %s before allocating", (scale) => {
        const engine = makeEngine();
        expect(() => createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: { surface: engine, scale } })).toThrow(
            /scale must be a positive finite number/
        );
        expect(engine._device.createTexture).not.toHaveBeenCalled();
    });

    it("rejects depth-only targets without the explicit helper before allocating", () => {
        const engine = makeEngine();
        expect(() => createSurfaceRenderTargetTexture(engine, { dFormat: "depth32float", samples: 1, size: engine })).toThrow(/Depth-only.*withSampledDepthTexture/);
        expect(engine._device.createTexture).not.toHaveBeenCalled();
    });

    it.each([false, true])("rejects sampled multisampled surface depth and releases its attachments (color: %s)", (color) => {
        const engine = makeEngine();
        expect(() =>
            createSurfaceRenderTargetTexture(engine, { format: color ? "rgba8unorm" : undefined, dFormat: "depth32float", samples: 4, size: engine }, withSampledDepthTexture)
        ).toThrow(/single-sample depth attachment/);
        const textures = vi.mocked(engine._device.createTexture).mock.results.map((result) => result.value as GPUTexture);
        expect(textures).toHaveLength(color ? 2 : 1);
        for (const texture of textures) {
            expect(texture.destroy).toHaveBeenCalledOnce();
            expect(texture.createView).toHaveBeenCalledOnce();
        }
        expect(engine._device.createSampler).not.toHaveBeenCalled();
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

    it("preserves a live sampled-depth generation when a resize requests multisampling", () => {
        const engine = makeEngine();
        const descriptor = { format: "rgba8unorm" as const, dFormat: "depth32float" as const, samples: 1, size: engine };
        const result = createSurfaceRenderTargetTexture(engine, descriptor, withSampledDepthTexture);
        const color = result.rt._colorTexture;
        const depth = result.depthTexture!.texture;
        const depthView = result.depthTexture!.view;
        const resized = vi.fn();
        onRenderTargetTextureResize(result, resized);
        descriptor.samples = 4;
        engine.canvas.width += 8;

        expect(() => buildRenderTarget(result.rt, engine)).toThrow(/attachment configuration cannot change/);
        expect(result.rt._colorTexture).toBe(color);
        expect(result.depthTexture!.texture).toBe(depth);
        expect(result.depthTexture!.view).toBe(depthView);
        expect(resized).not.toHaveBeenCalled();
        const replacements = vi
            .mocked(engine._device.createTexture)
            .mock.results.slice(2)
            .map((entry) => entry.value as GPUTexture);
        expect(replacements).toHaveLength(2);
        for (const texture of replacements) {
            expect(texture.destroy).toHaveBeenCalledOnce();
        }
        expect(color!.destroy).not.toHaveBeenCalled();
        expect(depth.destroy).not.toHaveBeenCalled();
        descriptor.samples = 1;
        buildRenderTarget(result.rt, engine);
        expect(resized).toHaveBeenCalledOnce();
        disposeGpuResourceRetirements(engine);
        disposeRenderTargetTexture(result);
    });

    it("cleans base ownership and preserves errors when surface setup fails", () => {
        const engine = makeEngine();
        const createTexture = vi.mocked(engine._device.createTexture);
        const allocate = createTexture.getMockImplementation()!;
        const defineProperty = vi.spyOn(Object, "defineProperty");
        createTexture.mockImplementationOnce((descriptor) => {
            const texture = allocate(descriptor);
            vi.mocked(texture.destroy).mockImplementation(() => {
                throw new Error("cleanup failed");
            });
            defineProperty.mockImplementationOnce(() => {
                throw new Error("surface setup failed");
            });
            return texture;
        });
        const descriptor = {
            format: "rgba8unorm" as GPUTextureFormat,
            samples: 1,
            size: engine,
        };
        try {
            expect(() => createSurfaceRenderTargetTexture(engine, descriptor)).toThrow("surface setup failed");
            expect((createTexture.mock.results[0]!.value as GPUTexture).destroy).toHaveBeenCalledOnce();
        } finally {
            defineProperty.mockRestore();
        }
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

    it.each(["color", "depth-only", "color-depth"] as const)("attempts every %s consumer and retries failed delivery without reallocating", (kind) => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(
            engine,
            {
                format: kind === "depth-only" ? undefined : "rgba8unorm",
                dFormat: kind === "color" ? undefined : "depth32float",
                samples: 1,
                size: engine,
            },
            kind === "color" ? undefined : withSampledDepthTexture
        );
        const oldColor = result.rt._colorTexture;
        const oldDepth = result.rt._depthTexture;
        let firstView = result.texture.view;
        let secondView = firstView;
        const failure = new Error("binding rebuild failed");
        const first = vi
            .fn(() => {
                firstView = result.texture.view;
            })
            .mockImplementationOnce(() => {
                throw failure;
            });
        const second = vi.fn(() => {
            secondView = result.texture.view;
        });
        onRenderTargetTextureResize(result, first);
        onRenderTargetTextureResize(result, second);
        engine.canvas.width += 8;

        let reported: unknown;
        try {
            buildRenderTarget(result.rt, engine);
        } catch (error) {
            reported = error;
        }
        expect(reported).toBe(failure);
        const replacement = result.texture.texture;
        const allocations = vi.mocked(engine._device.createTexture).mock.calls.length;
        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
        expect(firstView).not.toBe(result.texture.view);
        expect(secondView).toBe(result.texture.view);
        disposeGpuResourceRetirements(engine);
        if (oldColor) {
            expect(oldColor.destroy).not.toHaveBeenCalled();
        }
        if (oldDepth) {
            expect(oldDepth.destroy).not.toHaveBeenCalled();
        }

        buildRenderTarget(result.rt, engine);

        expect(first).toHaveBeenCalledTimes(2);
        expect(second).toHaveBeenCalledOnce();
        expect(firstView).toBe(result.texture.view);
        expect(result.texture.texture).toBe(replacement);
        expect(engine._device.createTexture).toHaveBeenCalledTimes(allocations);
        if (oldColor) {
            expect(oldColor.destroy).not.toHaveBeenCalled();
        }
        disposeGpuResourceRetirements(engine);
        if (oldColor) {
            expect(oldColor.destroy).toHaveBeenCalledOnce();
        }
        if (oldDepth) {
            expect(oldDepth.destroy).toHaveBeenCalledOnce();
        }
        expect(replacement.destroy).not.toHaveBeenCalled();
        buildRenderTarget(result.rt, engine);
        expect(first).toHaveBeenCalledTimes(2);
        expect(second).toHaveBeenCalledOnce();
        disposeRenderTargetTexture(result);
    });

    it("reports every callback error and retains attachments until every retry succeeds", () => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: engine });
        const old = result.texture.texture;
        const failure = new Error("second consumer failed");
        const first = vi.fn().mockImplementationOnce(() => {
            throw undefined;
        });
        const second = vi
            .fn()
            .mockImplementationOnce(() => {
                throw failure;
            })
            .mockImplementationOnce(() => {
                throw failure;
            });
        const third = vi.fn();
        onRenderTargetTextureResize(result, first);
        onRenderTargetTextureResize(result, second);
        onRenderTargetTextureResize(result, third);
        engine.canvas.width += 8;
        let thrown: unknown;
        try {
            buildRenderTarget(result.rt, engine);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(AggregateError);
        expect(thrown).toMatchObject({ errors: [undefined, failure] });
        expect(third).toHaveBeenCalledOnce();

        expect(() => buildRenderTarget(result.rt, engine)).toThrow(failure);
        expect(first).toHaveBeenCalledTimes(2);
        expect(second).toHaveBeenCalledTimes(2);
        expect(third).toHaveBeenCalledOnce();
        disposeGpuResourceRetirements(engine);
        expect(old.destroy).not.toHaveBeenCalled();

        buildRenderTarget(result.rt, engine);
        expect(first).toHaveBeenCalledTimes(2);
        expect(second).toHaveBeenCalledTimes(3);
        expect(third).toHaveBeenCalledOnce();
        disposeGpuResourceRetirements(engine);
        expect(old.destroy).toHaveBeenCalledOnce();
        disposeRenderTargetTexture(result);
    });

    it("cancels one failed duplicate registration without removing its successful peer", () => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: engine });
        const old = result.texture.texture;
        const callback = vi.fn().mockImplementationOnce(() => {
            throw new Error("first registration failed");
        });
        const unregisterFirst = onRenderTargetTextureResize(result, callback);
        onRenderTargetTextureResize(result, callback);
        engine.canvas.width += 8;
        expect(() => buildRenderTarget(result.rt, engine)).toThrow("first registration failed");
        expect(callback).toHaveBeenCalledTimes(2);
        unregisterFirst();
        unregisterFirst();

        expect(callback).toHaveBeenCalledTimes(2);
        disposeGpuResourceRetirements(engine);
        expect(old.destroy).toHaveBeenCalledOnce();
        engine.canvas.width += 8;
        buildRenderTarget(result.rt, engine);
        expect(callback).toHaveBeenCalledTimes(3);
        disposeRenderTargetTexture(result);
        disposeGpuResourceRetirements(engine);
    });

    it.each([false, true])("fences all held generations after canceling the last failure without another build (sampled depth: %s)", async (sampledDepth) => {
        const engine = makeEngine();
        let finishFence!: () => void;
        const fence = new Promise<undefined>((resolve) => {
            finishFence = () => resolve(undefined);
        });
        const queueFence = vi.mocked(engine._device.queue.onSubmittedWorkDone).mockReturnValue(fence);
        const result = createSurfaceRenderTargetTexture(
            engine,
            { format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: engine },
            sampledDepth ? withSampledDepthTexture : undefined
        );
        const failed = vi.fn(() => {
            throw new Error("binding failed");
        });
        const successful = vi.fn();
        const unregister = onRenderTargetTextureResize(result, failed);
        onRenderTargetTextureResize(result, successful);
        const held: GPUTexture[] = [];
        for (let generation = 0; generation < 2; generation++) {
            held.push(result.rt._colorTexture!, result.rt._depthTexture!);
            engine.canvas.width += 8;
            expect(() => buildRenderTarget(result.rt, engine)).toThrow("binding failed");
        }
        const current = [result.rt._colorTexture!, result.rt._depthTexture!];
        expect(queueFence).not.toHaveBeenCalled();

        unregister();
        unregister();
        await Promise.resolve();

        expect(queueFence).toHaveBeenCalledOnce();
        expect(engine._device.createTexture).toHaveBeenCalledTimes(6);
        expect(failed).toHaveBeenCalledTimes(2);
        expect(successful).toHaveBeenCalledTimes(2);
        for (const texture of held) {
            expect(texture.destroy).not.toHaveBeenCalled();
        }
        finishFence();
        await fence;
        for (const texture of held) {
            expect(texture.destroy).toHaveBeenCalledOnce();
        }
        for (const texture of current) {
            expect(texture.destroy).not.toHaveBeenCalled();
        }
        expect(result.rt._disposed).not.toBe(true);
        disposeRenderTargetTexture(result);
    });

    it("does not retire or retry other failed observers when only one subscription is canceled", () => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: engine });
        const old = result.texture.texture;
        const first = vi.fn(() => {
            throw new Error("first failure");
        });
        const second = vi.fn(() => {
            throw new Error("second failure");
        });
        const unregisterFirst = onRenderTargetTextureResize(result, first);
        const unregisterSecond = onRenderTargetTextureResize(result, second);
        engine.canvas.width += 8;
        expect(() => buildRenderTarget(result.rt, engine)).toThrow(AggregateError);

        unregisterFirst();
        disposeGpuResourceRetirements(engine);
        expect(old.destroy).not.toHaveBeenCalled();
        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
        unregisterSecond();
        disposeGpuResourceRetirements(engine);
        expect(old.destroy).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
        disposeRenderTargetTexture(result);
    });

    it("defers cancellation settlement until the currently executing callback returns", () => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: engine });
        const old = result.texture.texture;
        const unregister = onRenderTargetTextureResize(result, () => {
            unregister();
            disposeGpuResourceRetirements(engine);
            expect(old.destroy).not.toHaveBeenCalled();
        });
        engine.canvas.width += 8;

        buildRenderTarget(result.rt, engine);

        disposeGpuResourceRetirements(engine);
        expect(old.destroy).toHaveBeenCalledOnce();
        disposeRenderTargetTexture(result);
    });

    it("handles subscription changes without skipping peers or calling newly registered consumers early", () => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: engine });
        const second = vi.fn();
        const third = vi.fn();
        const added = vi.fn();
        let addedOnce = false;
        onRenderTargetTextureResize(result, function (this: unknown) {
            expect(this).toBeUndefined();
            unregisterSecond();
            if (!addedOnce) {
                addedOnce = true;
                onRenderTargetTextureResize(result, added);
            }
        });
        const unregisterSecond = onRenderTargetTextureResize(result, second);
        onRenderTargetTextureResize(result, third);
        engine.canvas.width += 8;

        buildRenderTarget(result.rt, engine);
        expect(second).not.toHaveBeenCalled();
        expect(third).toHaveBeenCalledOnce();
        expect(added).not.toHaveBeenCalled();
        engine.canvas.width += 8;
        buildRenderTarget(result.rt, engine);
        expect(third).toHaveBeenCalledTimes(2);
        expect(added).toHaveBeenCalledOnce();
        disposeRenderTargetTexture(result);
        disposeGpuResourceRetirements(engine);
    });

    it("delivers the newest resize and retires every older generation after a pending failure", () => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: engine });
        const original = result.texture.texture;
        let boundTexture = original;
        const first = vi
            .fn(() => {
                boundTexture = result.texture.texture;
            })
            .mockImplementationOnce(() => {
                throw new Error("binding failed");
            });
        const second = vi.fn();
        onRenderTargetTextureResize(result, first);
        onRenderTargetTextureResize(result, second);
        engine.canvas.width += 8;
        expect(() => buildRenderTarget(result.rt, engine)).toThrow("binding failed");
        const intermediate = result.texture.texture;
        disposeGpuResourceRetirements(engine);
        expect(original.destroy).not.toHaveBeenCalled();
        engine.canvas.width += 8;

        buildRenderTarget(result.rt, engine);
        expect(boundTexture).toBe(result.texture.texture);
        expect(boundTexture).not.toBe(intermediate);
        expect(first).toHaveBeenCalledTimes(2);
        expect(second).toHaveBeenCalledTimes(2);
        expect(original.destroy).not.toHaveBeenCalled();
        expect(intermediate.destroy).not.toHaveBeenCalled();
        disposeGpuResourceRetirements(engine);
        expect(original.destroy).toHaveBeenCalledOnce();
        expect(intermediate.destroy).toHaveBeenCalledOnce();
        expect(boundTexture.destroy).not.toHaveBeenCalled();
        disposeRenderTargetTexture(result);
    });

    it.each([false, true])("cancels pending delivery and fences held attachments during disposal (current release fails: %s)", (releaseFails) => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: engine }, withSampledDepthTexture);
        const old = [result.rt._colorTexture!, result.rt._depthTexture!];
        const callback = vi.fn(() => {
            throw new Error("consumer failed");
        });
        const unregister = onRenderTargetTextureResize(result, callback);
        engine.canvas.width += 8;
        expect(() => buildRenderTarget(result.rt, engine)).toThrow("consumer failed");
        const current = [result.rt._colorTexture!, result.rt._depthTexture!];

        if (releaseFails) {
            vi.mocked(current[0]!.destroy).mockImplementationOnce(() => {
                throw new Error("current attachment release failed");
            });
            expect(() => disposeRenderTargetTexture(result)).toThrow("current attachment release failed");
        } else {
            disposeRenderTargetTexture(result);
        }
        unregister();
        disposeRenderTargetTexture(result);
        expect(callback).toHaveBeenCalledOnce();
        for (const texture of current) {
            expect(texture.destroy).toHaveBeenCalledOnce();
        }
        for (const texture of old) {
            expect(texture.destroy).not.toHaveBeenCalled();
        }
        disposeGpuResourceRetirements(engine);
        disposeGpuResourceRetirements(engine);
        for (const texture of old) {
            expect(texture.destroy).toHaveBeenCalledOnce();
        }
        expect(() => buildRenderTarget(result.rt, engine)).toThrow(/disposed/);
        expect(callback).toHaveBeenCalledOnce();
    });

    it("allows an unchanged-size nested build without recursively delivering callbacks", () => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: engine });
        let calls = 0;
        onRenderTargetTextureResize(result, () => {
            if (++calls > 1) {
                throw new Error("callback reentered");
            }
            buildRenderTarget(result.rt, engine);
        });
        const second = vi.fn();
        onRenderTargetTextureResize(result, second);
        engine.canvas.width += 8;

        buildRenderTarget(result.rt, engine);
        expect(calls).toBe(1);
        expect(second).toHaveBeenCalledOnce();
        expect(engine._device.createTexture).toHaveBeenCalledTimes(2);
        disposeRenderTargetTexture(result);
        disposeGpuResourceRetirements(engine);
    });

    it("rejects recursive reallocation and leaves a later explicit build retryable", () => {
        const engine = makeEngine();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: engine });
        let nestedResize = true;
        const first = vi.fn(() => {
            if (nestedResize) {
                nestedResize = false;
                engine.canvas.width += 8;
                buildRenderTarget(result.rt, engine);
            }
        });
        const second = vi.fn();
        onRenderTargetTextureResize(result, first);
        onRenderTargetTextureResize(result, second);
        engine.canvas.width += 8;

        expect(() => buildRenderTarget(result.rt, engine)).toThrow(/cannot resize recursively/);
        expect(second).toHaveBeenCalledOnce();
        expect(engine._device.createTexture).toHaveBeenCalledTimes(2);
        buildRenderTarget(result.rt, engine);
        expect(first).toHaveBeenCalledTimes(2);
        expect(second).toHaveBeenCalledTimes(2);
        expect(result.texture.width).toBe(engine.canvas.width);
        disposeRenderTargetTexture(result);
        disposeGpuResourceRetirements(engine);
    });
});
