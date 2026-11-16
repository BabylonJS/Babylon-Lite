import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { buildRenderTarget, createRenderTarget, disposeRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { acquireTexture, releaseTexture, _textureOwners } from "../../../packages/babylon-lite/src/resource/gpu-pool";
import { createRenderTargetTexture, disposeRenderTargetTexture } from "../../../packages/babylon-lite/src/texture/rtt";
import { withSampledDepthTexture } from "../../../packages/babylon-lite/src/texture/rtt-depth";
import { createRenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import { createSceneContext, disposeScene } from "../../../packages/babylon-lite/src/scene/scene-core";
import { cloneTexture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

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
    it("shares ownership callbacks without sharing target lifetimes", () => {
        const engine = makeEngine();
        const descriptor = { format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: { width: 8, height: 8 } } as const;
        const first = createRenderTargetTexture(engine, descriptor);
        const second = createRenderTargetTexture(engine, descriptor);
        expect(first.rt._disposeAttachments).toBe(second.rt._disposeAttachments);
        expect(first.rt._syncEager).toBe(second.rt._syncEager);

        disposeRenderTargetTexture(first);

        expect(first.rt._disposed).toBe(true);
        expect(second.rt._disposed).toBeUndefined();
        expect(() => buildRenderTarget(first.rt, engine)).toThrow(/disposed/);
        expect(() => buildRenderTarget(second.rt, engine)).not.toThrow();
        expect(second.texture.texture.destroy).not.toHaveBeenCalled();
        disposeRenderTargetTexture(second);
    });

    it.each([false, true])("detaches attachments before reentrant disposal (sampled: %s)", (sampled) => {
        const engine = makeEngine();
        const descriptor = { format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: { width: 8, height: 8 } } as const;
        const rt = sampled ? createRenderTargetTexture(engine, descriptor).rt : createRenderTarget(descriptor);
        buildRenderTarget(rt, engine);
        const color = rt._colorTexture!;
        const depth = rt._depthTexture!;
        vi.mocked(color.destroy).mockImplementationOnce(() => {
            expect(rt._colorTexture).toBeNull();
            expect(rt._depthTexture).toBeNull();
            disposeRenderTarget(rt);
        });

        disposeRenderTarget(rt);

        expect(color.destroy).toHaveBeenCalledOnce();
        expect(depth.destroy).toHaveBeenCalledOnce();
    });

    it.each([false, true])("detaches attachments after a failed release (sampled: %s)", (sampled) => {
        const engine = makeEngine();
        const descriptor = { format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: { width: 8, height: 8 } } as const;
        const rt = sampled ? createRenderTargetTexture(engine, descriptor).rt : createRenderTarget(descriptor);
        buildRenderTarget(rt, engine);
        const color = rt._colorTexture!;
        const depth = rt._depthTexture!;
        const failure = new Error("release failed");
        vi.mocked(color.destroy).mockImplementation(() => {
            throw failure;
        });

        expect(() => disposeRenderTarget(rt)).toThrow(failure);
        expect(rt._colorTexture).toBeNull();
        expect(rt._depthTexture).toBeNull();
        expect(rt._colorView).toBeNull();
        expect(rt._depthView).toBeNull();
        expect(rt._width).toBe(0);
        expect(rt._height).toBe(0);
        expect(() => disposeRenderTarget(rt)).not.toThrow();
        expect(color.destroy).toHaveBeenCalledOnce();
        expect(depth.destroy).toHaveBeenCalledOnce();
    });

    it("detaches ordinary borrowed depth without destroying its allocation", () => {
        const engine = makeEngine();
        const rt = createRenderTarget({ format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: { width: 8, height: 8 } });
        buildRenderTarget(rt, engine);
        const color = rt._colorTexture!;
        const depth = rt._depthTexture!;
        rt._ownsDepthTexture = false;

        disposeRenderTarget(rt);

        expect(color.destroy).toHaveBeenCalledOnce();
        expect(depth.destroy).not.toHaveBeenCalled();
        expect(rt._depthTexture).toBeNull();
        expect(rt._depthView).toBeNull();
        expect(rt._width).toBe(0);
        expect(rt._height).toBe(0);
    });

    it("owns depth-test attachments without opting into sampled depth", () => {
        const result = createRenderTargetTexture(makeEngine(), {
            format: "rgba8unorm",
            dFormat: "depth32float",
            samples: 1,
            size: { width: 8, height: 8 },
        });
        const depth = result.rt._depthTexture!;
        expect(result.depthTexture).toBeNull();
        expect(depth.createView).toHaveBeenCalledOnce();
        disposeRenderTargetTexture(result);
        expect(depth.destroy).toHaveBeenCalledOnce();
    });

    it("rejects sampled depth without a depth attachment and cleans up its allocation", () => {
        const engine = makeEngine();
        expect(() =>
            createRenderTargetTexture(
                engine,
                {
                    format: "rgba8unorm",
                    samples: 1,
                    size: { width: 8, height: 8 },
                },
                withSampledDepthTexture
            )
        ).toThrow(/requires a single-sample depth attachment/);
        const texture = vi.mocked(engine._device.createTexture).mock.results[0]!.value as GPUTexture;
        expect(texture.destroy).toHaveBeenCalledOnce();
    });

    it.each([false, true])("rejects sampled multisampled depth and releases its attachments (color: %s)", (color) => {
        const engine = makeEngine();
        expect(() =>
            createRenderTargetTexture(
                engine,
                { format: color ? "rgba8unorm" : undefined, dFormat: "depth32float", samples: 4, size: { width: 8, height: 8 } },
                withSampledDepthTexture
            )
        ).toThrow(/single-sample depth attachment/);

        const textures = vi.mocked(engine._device.createTexture).mock.results.map((result) => result.value as GPUTexture);
        expect(textures).toHaveLength(color ? 2 : 1);
        for (const texture of textures) {
            expect(texture.destroy).toHaveBeenCalledOnce();
            expect(texture.createView).toHaveBeenCalledOnce();
        }
        expect(engine._device.createSampler).not.toHaveBeenCalled();
    });

    it("checks the depth allocation's sample count rather than the target descriptor", () => {
        const engine = makeEngine();
        const rt = createRenderTarget({ dFormat: "depth32float", samples: 1, size: { width: 8, height: 8 } });
        const texture = engine._device.createTexture({ format: "depth32float", size: [8, 8], sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
        rt._depthTexture = texture;

        expect(() => withSampledDepthTexture(engine, rt)).toThrow(/single-sample depth attachment/);
        expect(texture.createView).not.toHaveBeenCalled();
        expect(engine._device.createSampler).not.toHaveBeenCalled();
        disposeRenderTarget(rt);
    });

    it("rejects surface-sized descriptors before allocating", () => {
        const engine = makeEngine();
        expect(() => createRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: engine })).toThrow(
            /descriptor\.size must be fixed.*createSurfaceRenderTargetTexture/
        );
        expect(() => createRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: { surface: engine, scale: 0.5 } })).toThrow(
            /descriptor\.size must be fixed.*createSurfaceRenderTargetTexture/
        );
        expect(engine._device.createTexture).not.toHaveBeenCalled();
    });

    it("keeps fixed clones as ordinary snapshots", () => {
        const engine = makeEngine();
        const result = createRenderTargetTexture(engine, { format: "rgba8unorm", samples: 1, size: { width: 8, height: 8 } });
        const clone = cloneTexture2D(result.texture, { uScale: 2 });
        const texture = result.texture.texture;
        const view = result.texture.view;
        const replacement = engine._device.createTexture({ size: [16, 16], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING });
        const replacementView = replacement.createView();
        expect(Object.getOwnPropertyDescriptor(result.texture, "texture")?.get).toBeUndefined();
        result.texture.texture = replacement;
        result.texture.view = replacementView;
        result.texture.width = 16;
        expect(clone.texture).toBe(texture);
        expect(clone.view).toBe(view);
        expect(clone.width).toBe(8);
        result.texture.texture = texture;
        result.texture.view = view;
        result.texture.width = 8;
        replacement.destroy();
        disposeRenderTargetTexture(result);
    });

    it("cleans partial fixed allocations while preserving the allocation error", () => {
        const engine = makeEngine();
        const createTexture = vi.mocked(engine._device.createTexture);
        const allocate = createTexture.getMockImplementation()!;
        createTexture.mockImplementationOnce(allocate).mockImplementationOnce(() => {
            throw new Error("depth allocation failed");
        });
        expect(() =>
            createRenderTargetTexture(engine, {
                format: "rgba8unorm",
                dFormat: "depth32float",
                samples: 1,
                size: { width: 8, height: 8 },
            })
        ).toThrow("depth allocation failed");
        expect((createTexture.mock.results[0]!.value as GPUTexture).destroy).toHaveBeenCalledOnce();
    });

    it("keeps writer attachments alive when the final sampled consumer is released", () => {
        const result = createRenderTargetTexture(
            makeEngine(),
            {
                format: "rgba8unorm",
                dFormat: "depth32float",
                samples: 1,
                size: { width: 8, height: 8 },
            },
            withSampledDepthTexture
        );
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
        const result = createRenderTargetTexture(
            engine,
            {
                format: "rgba8unorm",
                dFormat: "depth32float",
                samples: 1,
                size: { width: 8, height: 8 },
            },
            withSampledDepthTexture
        );
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
        const result = createRenderTargetTexture(
            engine,
            {
                format: "rgba8unorm",
                dFormat: "depth32float",
                samples: 1,
                size: { width: 8, height: 8 },
            },
            withSampledDepthTexture
        );
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
        const result = createRenderTargetTexture(
            makeEngine(),
            {
                format: "rgba8unorm",
                dFormat: "depth32float",
                samples: 1,
                size: { width: 64, height: 32 },
            },
            withSampledDepthTexture
        );

        expect(result.texture.texture).toBe(result.rt._colorTexture);
        expect(result.depthTexture?.texture).toBe(result.rt._depthTexture);
        expect(result.depthTexture?._sampleType).toBe("depth");
        expect(result.depthTexture?.invertY).toBe(false);
    });

    it("rejects depth-only targets without the explicit helper before allocating", () => {
        const engine = makeEngine();
        expect(() =>
            createRenderTargetTexture(engine, {
                dFormat: "depth32float",
                samples: 1,
                size: { width: 16, height: 16 },
            })
        ).toThrow(/Depth-only.*withSampledDepthTexture/);
        expect(engine._device.createTexture).not.toHaveBeenCalled();
    });

    it("returns explicit sampled depth as the primary texture for a depth-only target", () => {
        const result = createRenderTargetTexture(
            makeEngine(),
            {
                dFormat: "depth32float",
                samples: 1,
                size: { width: 16, height: 16 },
            },
            withSampledDepthTexture
        );

        expect(result.texture).toBe(result.depthTexture);
        expect(result.texture.texture).toBe(result.rt._depthTexture);
        expect(result.texture._sampleType).toBe("depth");
        expect(result.texture.invertY).toBe(false);
        expect(result.rt._depthTexture?.createView).toHaveBeenCalledWith({ aspect: "depth-only" });
        expect(_textureOwners(result.texture)).toBe(1);
        disposeRenderTargetTexture(result);
        expect(result.texture.texture.destroy).toHaveBeenCalledOnce();
    });
});
