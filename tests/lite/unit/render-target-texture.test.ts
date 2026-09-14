import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { buildRenderTarget, createRenderTarget, disposeRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { disposeGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import { acquireTexture, releaseTexture, _textureOwners } from "../../../packages/babylon-lite/src/resource/gpu-pool";
import { createRenderTargetTexture, disposeRenderTargetTexture, onRenderTargetTextureResize } from "../../../packages/babylon-lite/src/texture/rtt";
import { createRenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import { createSceneContext, disposeScene } from "../../../packages/babylon-lite/src/scene/scene-core";
import { cloneTexture2D, type Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

const gpuGlobals = globalThis as unknown as Omit<typeof globalThis, "GPUTextureUsage"> & {
    GPUTextureUsage?: Record<string, number>;
};
gpuGlobals.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 8 };

function makeEngine(): EngineContext {
    const device = {
        createBuffer: vi.fn(() => ({ destroy: vi.fn() }) as unknown as GPUBuffer),
        createBindGroupLayout: vi.fn(() => ({}) as GPUBindGroupLayout),
        createBindGroup: vi.fn(() => ({}) as GPUBindGroup),
        queue: { writeBuffer: vi.fn() },
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

describe("createRenderTargetTexture", () => {
    it.each(["color", "depth", "depth-only"] as const)("keeps %s clones on the current allocation across repeated resizes", (kind) => {
        const engine = makeEngine();
        const result = createRenderTargetTexture(engine, {
            format: kind === "depth-only" ? undefined : "rgba8unorm",
            dFormat: "depth32float",
            samples: 1,
            size: engine,
        });
        const base = kind === "color" ? result.texture : result.depthTexture!;
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
        const result = createRenderTargetTexture(engine, { format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: engine });
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

    it("retains snapshot behavior for ordinary texture clones even after RTT support is installed", () => {
        const engine = makeEngine();
        const rtt = createRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: engine });
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

    it("keeps writer attachments alive when the final sampled consumer is released", () => {
        const result = createRenderTargetTexture(makeEngine(), {
            format: "rgba8unorm",
            dFormat: "depth32float",
            samples: 1,
            size: { width: 8, height: 8 },
        });
        for (const facade of [result.texture, result.depthTexture!]) {
            expect(_textureOwners(facade)).toBe(1);
            acquireTexture(facade);
            expect(releaseTexture(facade)).toBe(false);
            expect(facade.texture.destroy).not.toHaveBeenCalled();
            expect(_textureOwners(facade)).toBe(1);
        }
        disposeRenderTargetTexture(result);
        disposeRenderTargetTexture(result);
        expect(result.texture.texture.destroy).toHaveBeenCalledOnce();
        expect(result.depthTexture!.texture.destroy).toHaveBeenCalledOnce();
        expect(() => buildRenderTarget(result.rt, makeEngine())).toThrow(/disposed/);
    });

    it("releases unsampled color while a depth sampler retains the last image after task disposal", () => {
        const engine = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const result = createRenderTargetTexture(engine, {
            format: "rgba8unorm",
            dFormat: "depth32float",
            samples: 1,
            size: { width: 8, height: 8 },
        });
        acquireTexture(result.depthTexture!);
        const task = createRenderTask({ name: "writer", rt: result.rt, autoMirror: false }, engine, scene);
        task.dispose();
        task.dispose();
        expect(result.texture.texture.destroy).toHaveBeenCalledOnce();
        expect(result.depthTexture!.texture.destroy).not.toHaveBeenCalled();
        expect(_textureOwners(result.depthTexture!)).toBe(1);
        releaseTexture(result.depthTexture!);
        expect(result.depthTexture!.texture.destroy).toHaveBeenCalledOnce();
    });

    it("does not dispose shared targets or borrowed eager depth with a borrower task", () => {
        const engine = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const result = createRenderTargetTexture(engine, {
            format: "rgba8unorm",
            dFormat: "depth32float",
            samples: 1,
            size: { width: 8, height: 8 },
        });
        createRenderTask({ name: "overlay", rt: result.rt, sharedRt: true }, engine, scene).dispose();
        const color = createRenderTarget({ format: "rgba8unorm", samples: 1, size: { width: 8, height: 8 } });
        createRenderTask({ name: "depth borrower", rt: color, depth: result.rt }, engine, scene).dispose();
        expect(result.texture.texture.destroy).not.toHaveBeenCalled();
        expect(result.depthTexture!.texture.destroy).not.toHaveBeenCalled();
        disposeRenderTargetTexture(result);
    });

    it("releases unsampled attachments when the owning scene disposes its task", () => {
        const engine = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const result = createRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: { width: 8, height: 8 } });
        const task = createRenderTask({ name: "scene writer", rt: result.rt }, engine, scene);
        scene._frameGraph._tasks.push(task);
        disposeScene(scene);
        expect(result.texture.texture.destroy).toHaveBeenCalledOnce();
    });

    it("exposes color and depth attachments from one eager render target", () => {
        const result = createRenderTargetTexture(makeEngine(), {
            format: "rgba8unorm",
            dFormat: "depth32float",
            samples: 1,
            size: { width: 64, height: 32 },
        });

        expect(result.texture.texture).toBe(result.rt._colorTexture);
        expect(result.depthTexture?.texture).toBe(result.rt._depthTexture);
        expect(result.depthTexture?._sampleType).toBe("depth");
        expect(result.depthTexture?.invertY).toBe(false);
    });

    it("returns the depth facade as the primary texture for a depth-only target", () => {
        const result = createRenderTargetTexture(makeEngine(), {
            dFormat: "depth32float",
            samples: 1,
            size: { width: 16, height: 16 },
        });

        expect(result.texture).toBe(result.depthTexture);
    });

    it("resizes a surface-sized eager target while preserving sampled facade identity", () => {
        const engine = makeEngine();
        const result = createRenderTargetTexture(engine, {
            dFormat: "depth32float",
            samples: 1,
            size: engine,
        });
        const facade = result.depthTexture!;
        const oldTexture = facade.texture;
        const resized = vi.fn();
        onRenderTargetTextureResize(result, resized);
        acquireTexture(facade);
        engine.canvas.width = 128;
        engine.canvas.height = 96;

        buildRenderTarget(result.rt, engine);

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
        const result = createRenderTargetTexture(engine, { format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: engine });
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
        const result = createRenderTargetTexture(engine, { format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: engine });
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
});
