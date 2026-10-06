import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { buildRenderTarget, createRenderTarget, disposeRenderTarget, type RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { disposeGpuResourceRetirements, waitForGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import { createMipMappedRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target-mipmaps";
import { createClearTextureTask } from "../../../packages/babylon-lite/src/frame-graph/clear-texture-task";
import { createCopyToTextureTask } from "../../../packages/babylon-lite/src/frame-graph/copy-to-texture-task";
import { createFrameGraph } from "../../../packages/babylon-lite/src/frame-graph/frame-graph";
import { createFrameGraphContext, disposeFrameGraphContext, registerFrameGraphContext } from "../../../packages/babylon-lite/src/frame-graph/frame-graph-context";
import { addTask } from "../../../packages/babylon-lite/src/frame-graph/frame-graph-actions";
import { createGenerateMipMapsTask } from "../../../packages/babylon-lite/src/frame-graph/generate-mipmaps-task";
import { createPostProcessTask } from "../../../packages/babylon-lite/src/frame-graph/post-process-task";
import type { Task } from "../../../packages/babylon-lite/src/frame-graph/task";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { setSurfaceSize } from "../../../packages/babylon-lite/src/engine/surface";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import { createTextureRenderTarget } from "../../../packages/babylon-lite/src/texture/texture-render-target";
import { withSampledDepthTexture } from "../../../packages/babylon-lite/src/texture/rtt-depth";
import { createSurfaceRenderTargetTexture } from "../../../packages/babylon-lite/src/texture/rtt-surface";
import { disposeRenderTargetTexture } from "../../../packages/babylon-lite/src/texture/rtt";

function mockGpu(features: GPUFeatureName[] = []) {
    const textures: GPUTexture[] = [];
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), setViewport: vi.fn(), setScissorRect: vi.fn(), draw: vi.fn(), end: vi.fn() };
    const encoder = { beginRenderPass: vi.fn((_descriptor: GPURenderPassDescriptor) => pass), copyTextureToTexture: vi.fn(), finish: vi.fn() };
    const device = {
        features: new Set(features),
        limits: { maxColorAttachments: 8, maxTextureDimension2D: 8192 },
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
            const size = descriptor.size as GPUExtent3DDict;
            const texture = {
                width: size.width,
                height: size.height ?? 1,
                depthOrArrayLayers: size.depthOrArrayLayers ?? 1,
                dimension: descriptor.dimension ?? "2d",
                mipLevelCount: descriptor.mipLevelCount ?? 1,
                sampleCount: descriptor.sampleCount ?? 1,
                format: descriptor.format,
                usage: descriptor.usage,
                createView: vi.fn((options?: GPUTextureViewDescriptor) => ({ texture, options }) as unknown as GPUTextureView),
                destroy: vi.fn(),
            } as unknown as GPUTexture;
            textures.push(texture);
            return texture;
        }),
        createShaderModule: vi.fn(() => ({}) as GPUShaderModule),
        createSampler: vi.fn(() => ({}) as GPUSampler),
        createBindGroupLayout: vi.fn(() => ({}) as GPUBindGroupLayout),
        createPipelineLayout: vi.fn(() => ({}) as GPUPipelineLayout),
        createRenderPipeline: vi.fn(() => ({}) as GPURenderPipeline),
        createBindGroup: vi.fn((_descriptor: GPUBindGroupDescriptor) => ({}) as GPUBindGroup),
        createCommandEncoder: vi.fn(() => encoder),
        queue: { submit: vi.fn(), onSubmittedWorkDone: vi.fn(() => Promise.resolve()) },
    };
    const engine = {
        _device: device,
        _currentEncoder: encoder,
        canvas: { width: 32, height: 16 },
        surfaces: [],
        _renderingContexts: [],
        scRT: createRenderTarget({ format: "bgra8unorm", samples: 1, size: { width: 32, height: 16 } }),
    } as unknown as EngineContext;
    Object.assign(engine, { engine });
    engine.scRT._eager = true;
    engine.scRT._width = 32;
    engine.scRT._height = 16;
    return { engine, device, encoder, pass, textures };
}

function target(engine: EngineContext, options: Partial<RenderTarget["_descriptor"]> = {}): RenderTarget {
    const rt = createRenderTarget({ format: "rgba8unorm", samples: 1, size: { width: 32, height: 16 }, ...options });
    buildRenderTarget(rt, engine);
    return rt;
}

function texture(engine: EngineContext, options: Partial<GPUTextureDescriptor> = {}): Texture2D {
    const gpu = engine._device.createTexture({
        size: { width: 32, height: 16 },
        format: "rgba8unorm",
        mipLevelCount: 6,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        ...options,
    });
    return { texture: gpu, view: gpu.createView(), sampler: {} as GPUSampler, width: gpu.width, height: gpu.height };
}

function graphFor(task: Task) {
    const graph = createFrameGraph(task.engine);
    addTask(graph, task);
    graph.build();
    return graph;
}

describe("ClearTextureTask", () => {
    it("keeps a color wrapper compatible with live depth after a real surface RTT resize", async () => {
        const { engine, device, encoder } = mockGpu();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: engine });
        const facade = result.texture;
        const wrapper = createTextureRenderTarget(engine, facade);
        const originalView = wrapper._colorView;
        const task = createClearTextureTask({ targetTexture: wrapper, depthTexture: result.rt, clearDepth: true }, engine);
        try {
            const graph = graphFor(task);
            const allocationsBeforeResize = device.createTexture.mock.calls.length;
            engine.canvas.width = 79;
            engine.canvas.height = 41;

            expect(() => graph.build()).not.toThrow();
            expect(device.createTexture).toHaveBeenCalledTimes(allocationsBeforeResize + 2);
            expect(result.texture).toBe(facade);
            expect(wrapper._colorTexture).toBe(facade.texture);
            expect(wrapper._colorView).not.toBe(originalView);
            expect([wrapper._width, wrapper._height]).toEqual([79, 41]);
            expect(wrapper._descriptor.size).toEqual({ width: 79, height: 41 });
            expect(graph.execute()).toBe(0);
            const descriptor = encoder.beginRenderPass.mock.calls[0]![0];
            expect(Array.from(descriptor.colorAttachments)[0]).toMatchObject({ view: wrapper._colorView });
            expect(descriptor.depthStencilAttachment).toMatchObject({ view: result.rt._depthView, depthLoadOp: "clear" });
        } finally {
            task.dispose();
            disposeRenderTarget(wrapper);
            disposeRenderTargetTexture(result);
            disposeGpuResourceRetirements(engine);
            await waitForGpuResourceRetirements(engine);
        }
    });

    it.each(["color", "depth"] as const)("refreshes a %s wrapper after a later task records its resized source", async (attachment) => {
        const { engine, device, encoder } = mockGpu();
        const result = createSurfaceRenderTargetTexture(engine, { format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: engine }, withSampledDepthTexture);
        const facade = attachment === "color" ? result.texture : result.depthTexture!;
        const wrapper = createTextureRenderTarget(engine, facade);
        const originalView = attachment === "color" ? wrapper._colorView : wrapper._depthView;
        const task = createClearTextureTask(attachment === "color" ? { targetTexture: wrapper } : { depthTexture: wrapper, clearDepth: true }, engine);
        const sourceTask = createClearTextureTask({ targetTexture: result.rt, depthTexture: result.rt }, engine);
        try {
            const graph = createFrameGraph(engine);
            addTask(graph, task);
            addTask(graph, sourceTask);
            graph.build();
            const allocationsBeforeResize = device.createTexture.mock.calls.length;
            engine.canvas.width = 79;
            engine.canvas.height = 41;

            expect(() => graph.build()).not.toThrow();
            expect(device.createTexture).toHaveBeenCalledTimes(allocationsBeforeResize + 2);
            expect(wrapper._colorTexture ?? wrapper._depthTexture).toBe(facade.texture);
            expect(attachment === "color" ? wrapper._colorView : wrapper._depthView).not.toBe(originalView);
            expect([wrapper._width, wrapper._height]).toEqual([79, 41]);
            expect(wrapper._descriptor.size).toEqual({ width: 79, height: 41 });
            expect(graph.execute()).toBe(0);
            const descriptor = encoder.beginRenderPass.mock.calls[0]![0];
            if (attachment === "color") {
                expect(Array.from(descriptor.colorAttachments)[0]).toMatchObject({ view: wrapper._colorView });
            } else {
                expect(descriptor.depthStencilAttachment).toMatchObject({ view: wrapper._depthView, depthLoadOp: "clear" });
            }
        } finally {
            task.dispose();
            sourceTask.dispose();
            disposeRenderTarget(wrapper);
            disposeRenderTargetTexture(result);
            disposeGpuResourceRetirements(engine);
            await waitForGpuResourceRetirements(engine);
        }
    });

    it("matches Babylon.js defaults and aliases borrowed color/depth outputs", () => {
        const { engine, device, encoder, pass } = mockGpu();
        const color = target(engine, { dFormat: "depth24plus-stencil8" });
        const depth = target(engine, { format: undefined, dFormat: "depth32float" });
        const task = createClearTextureTask({ targetTexture: color, depthTexture: depth }, engine);
        expect(task.color).toEqual({ r: 0.2, g: 0.2, b: 0.3, a: 1 });
        expect([task.clearColor, task.clearDepth, task.clearStencil, task.convertColorToLinearSpace, task.stencilValue]).toEqual([true, false, false, false, 0]);
        expect(task.outputTexture).toBe(color);
        expect(task.outputDepthTexture).toBe(depth);

        const allocationsBeforeBuild = device.createTexture.mock.calls.length;
        const graph = graphFor(task);
        graph.build();
        expect(device.createTexture).toHaveBeenCalledTimes(allocationsBeforeBuild);
        expect(graph.execute()).toBe(0);
        const descriptor = encoder.beginRenderPass.mock.calls[0]![0] as GPURenderPassDescriptor;
        expect(Array.from(descriptor.colorAttachments)).toEqual([{ view: color._colorView, loadOp: "clear", storeOp: "store", clearValue: task.color }]);
        expect(descriptor.depthStencilAttachment).toMatchObject({ view: depth._depthView, depthLoadOp: "load", depthStoreOp: "store", depthClearValue: 0 });
        expect(descriptor.depthStencilAttachment).not.toHaveProperty("stencilLoadOp");
        expect(pass.draw).not.toHaveBeenCalled();
        expect(pass.end).toHaveBeenCalledOnce();
        expect(task._passes[0]!._dependencies).toEqual(new Set([color, depth]));
        graph.dispose();
        expect(color._colorTexture!.destroy).not.toHaveBeenCalled();
        expect(depth._depthTexture!.destroy).not.toHaveBeenCalled();
    });

    it("never clears a color target's implicit depth attachment", () => {
        const { engine, encoder } = mockGpu();
        const color = target(engine, { dFormat: "depth24plus-stencil8" });
        const task = createClearTextureTask({ targetTexture: color, clearDepth: true, clearStencil: true }, engine);
        graphFor(task).execute();
        expect(encoder.beginRenderPass.mock.calls[0]![0]).not.toHaveProperty("depthStencilAttachment", expect.anything());
        expect(task.outputDepthTexture).toBeUndefined();
    });

    it.each([
        [false, false, false],
        [true, false, false],
        [false, true, false],
        [false, false, true],
        [true, true, false],
        [true, false, true],
        [false, true, true],
        [true, true, true],
    ])("independently clears color=%s depth=%s stencil=%s", (clearColor, clearDepth, clearStencil) => {
        const { engine, encoder } = mockGpu();
        const color = target(engine);
        const depth = target(engine, { format: undefined, dFormat: "depth24plus-stencil8", depthClearValue: 1 });
        const task = createClearTextureTask({ targetTexture: color, depthTexture: depth, clearColor, clearDepth, clearStencil, stencilValue: 7 }, engine);
        graphFor(task).execute();
        if (!clearColor && !clearDepth && !clearStencil) {
            expect(encoder.beginRenderPass).not.toHaveBeenCalled();
            return;
        }
        const descriptor = encoder.beginRenderPass.mock.calls[0]![0] as GPURenderPassDescriptor;
        expect(Array.from(descriptor.colorAttachments)[0]!.loadOp).toBe(clearColor ? "clear" : "load");
        expect(descriptor.depthStencilAttachment).toMatchObject({
            depthClearValue: 1,
            depthLoadOp: clearDepth ? "clear" : "load",
            depthStoreOp: "store",
            stencilClearValue: 7,
            stencilLoadOp: clearStencil ? "clear" : "load",
            stencilStoreOp: "store",
        });
        expect(Array.from(descriptor.colorAttachments)[0]).not.toHaveProperty("resolveTarget");
    });

    it.each(["depth32float", "depth24plus-stencil8", "stencil8"] as const)("supports an explicit %s target without color", (dFormat) => {
        const { engine, encoder } = mockGpu();
        const depth = target(engine, { format: undefined, dFormat });
        const task = createClearTextureTask({ depthTexture: depth, clearDepth: true, clearStencil: true }, engine);
        graphFor(task).execute();
        const descriptor = encoder.beginRenderPass.mock.calls[0]![0] as GPURenderPassDescriptor;
        expect(Array.from(descriptor.colorAttachments)).toEqual([]);
        expect(task.outputTexture).toBeUndefined();
        expect(task.outputDepthTexture).toBe(depth);
        expect("depthLoadOp" in descriptor.depthStencilAttachment!).toBe(dFormat !== "stencil8");
        expect("stencilLoadOp" in descriptor.depthStencilAttachment!).toBe(dFormat !== "depth32float");
    });

    it("clears all MRT colors with the first target as its output", () => {
        const { engine, encoder } = mockGpu();
        const colors = [target(engine), target(engine)];
        const task = createClearTextureTask({ targetTexture: colors }, engine);
        graphFor(task).execute();
        expect(task.outputTexture).toBe(colors[0]);
        expect(Array.from((encoder.beginRenderPass.mock.calls[0]![0] as GPURenderPassDescriptor).colorAttachments)).toHaveLength(2);
        expect(task._passes[0]!._dependencies).toEqual(new Set(colors));
    });

    it("converts RGB to linear space without changing alpha or the source, and reads live settings", () => {
        const { engine, encoder } = mockGpu();
        const color = { r: 0.5, g: 0.25, b: 0.75, a: 0.4 };
        const task = createClearTextureTask({ targetTexture: target(engine), color, convertColorToLinearSpace: true }, engine);
        const graph = graphFor(task);
        graph.execute();
        const descriptor = encoder.beginRenderPass.mock.calls[0]![0] as GPURenderPassDescriptor;
        const value = Array.from(descriptor.colorAttachments)[0]!.clearValue;
        expect(value).toEqual({ r: 0.5 ** 2.2, g: 0.25 ** 2.2, b: 0.75 ** 2.2, a: 0.4 });
        expect(color).toEqual({ r: 0.5, g: 0.25, b: 0.75, a: 0.4 });
        task.convertColorToLinearSpace = false;
        task.color = { r: 0.9, g: 0.8, b: 0.7, a: 1 };
        graph.execute();
        expect(value).toEqual({ r: 0.9, g: 0.8, b: 0.7, a: 1 });
        expect(encoder.beginRenderPass.mock.calls[1]![0]).toBe(descriptor);
        task.clearColor = false;
        graph.execute();
        expect(encoder.beginRenderPass).toHaveBeenCalledTimes(2);
    });

    it("reads the current swapchain view each frame and obeys the execution gate", () => {
        const { engine, encoder } = mockGpu();
        const task = createClearTextureTask({ targetTexture: engine.scRT }, engine);
        const graph = graphFor(task);
        const first = {} as GPUTextureView;
        engine.scRT._colorView = first;
        graph.execute();
        const descriptor = encoder.beginRenderPass.mock.calls[0]![0] as GPURenderPassDescriptor;
        expect(Array.from(descriptor.colorAttachments)[0]!.view).toBe(first);
        const next = {} as GPUTextureView;
        engine.scRT._colorView = next;
        graph.execute();
        expect(Array.from(descriptor.colorAttachments)[0]!.view).toBe(next);
        task.executionEnabled = false;
        graph.execute();
        expect(encoder.beginRenderPass).toHaveBeenCalledTimes(2);
    });

    it("initializes after later producer tasks allocate targets and rebinds on rebuild", () => {
        const { engine, device, encoder } = mockGpu();
        const rt = createRenderTarget({ format: "rgba8unorm", samples: 1, size: engine });
        const clear = createClearTextureTask({ targetTexture: rt }, engine);
        const graph = createFrameGraph(engine);
        addTask(graph, clear);
        addTask(graph, { name: "producer", engine, _passes: [], record: () => buildRenderTarget(rt, engine), dispose: () => disposeRenderTarget(rt) });
        graph.build();
        expect(device.createTexture).toHaveBeenCalledTimes(2);
        graph.execute();
        const old = rt._colorTexture;
        engine.canvas.width = 64;
        graph.build();
        graph.execute();
        expect(rt._colorTexture).not.toBe(old);
        expect(Array.from((encoder.beginRenderPass.mock.calls[1]![0] as GPURenderPassDescriptor).colorAttachments)[0]!.view).toBe(rt._colorView);
        expect(clear._passes).toHaveLength(1);
    });

    it("synchronizes eager targets and rejects invalid or incompatible attachments", () => {
        const { engine } = mockGpu();
        expect(() => graphFor(createClearTextureTask({}, engine))).toThrow(/required/);
        expect(() => graphFor(createClearTextureTask({ targetTexture: [] }, engine))).toThrow(/empty/);
        const color = target(engine);
        const depthOnly = target(engine, { format: undefined, dFormat: "depth32float" });
        expect(() => graphFor(createClearTextureTask({ targetTexture: depthOnly }, engine))).toThrow(/color attachment/);
        expect(() => graphFor(createClearTextureTask({ depthTexture: color }, engine))).toThrow(/depth\/stencil/);
        expect(() => graphFor(createClearTextureTask({ targetTexture: [color, color] }, engine))).toThrow(/distinct textures/);
        expect(() => graphFor(createClearTextureTask({ targetTexture: Array.from({ length: 9 }, () => target(engine)) }, engine))).toThrow(/too many color attachments/);
        expect(() => graphFor(createClearTextureTask({ targetTexture: [color, target(engine, { size: { width: 16, height: 16 } })] }, engine))).toThrow(/dimensions/);
        expect(() => graphFor(createClearTextureTask({ targetTexture: color, depthTexture: target(engine, { dFormat: "depth32float", samples: 4 }) }, engine))).toThrow(
            /sample counts/
        );
        color._eager = true;
        color._syncEager = vi.fn();
        graphFor(createClearTextureTask({ targetTexture: color }, engine));
        expect(color._syncEager).toHaveBeenCalledWith(engine);
    });

    it("allocates ordinary clear outputs before the first downstream copy records", () => {
        const { engine, encoder, device } = mockGpu();
        const rt = createRenderTarget({ format: "rgba8unorm", samples: 1, size: { width: 32, height: 16 } });
        const destination = createRenderTarget({ format: "rgba8unorm", samples: 1, size: { width: 32, height: 16 } });
        const clear = createClearTextureTask({ targetTexture: rt }, engine);
        const copy = createCopyToTextureTask({ sourceTexture: clear.outputTexture!, targetTexture: destination }, engine, {} as SceneContext);
        const graph = createFrameGraph(engine);
        addTask(graph, clear);
        addTask(graph, copy);

        expect(rt._colorTexture).toBeNull();
        graph.build();
        expect(device.createTexture).toHaveBeenCalledTimes(2);
        const source = rt._colorTexture!;
        const output = destination._colorTexture!;
        expect(graph.execute()).toBe(0);
        expect(encoder.beginRenderPass).toHaveBeenCalledOnce();
        expect(encoder.copyTextureToTexture).toHaveBeenCalledWith({ texture: source, mipLevel: 0 }, { texture: output }, { width: 32, height: 16 });
        expect(encoder.beginRenderPass.mock.invocationCallOrder[0]).toBeLessThan(encoder.copyTextureToTexture.mock.invocationCallOrder[0]!);
        graph.dispose();
        expect(source.destroy).not.toHaveBeenCalled();
        expect(output.destroy).not.toHaveBeenCalled();
        disposeRenderTarget(rt);
        disposeRenderTarget(destination);
    });

    it("refreshes a standalone swapchain clear's borrowed depth on surface resize", () => {
        const { engine, encoder } = mockGpu();
        engine.scRT._colorView = {} as GPUTextureView;
        const depth = createRenderTarget({ dFormat: "depth32float", samples: 1, size: engine });
        const clear = createClearTextureTask({ targetTexture: engine.scRT, depthTexture: depth, clearDepth: true }, engine);
        const context = createFrameGraphContext(engine);
        addTask(context.frameGraph, clear);
        registerFrameGraphContext(context);
        const original = depth._depthTexture!;
        expect([depth._width, depth._height]).toEqual([32, 16]);
        expect(context.frameGraph.execute()).toBe(0);

        setSurfaceSize(engine, 64, 48);
        expect([depth._width, depth._height]).toEqual([64, 48]);
        expect(depth._depthTexture).not.toBe(original);
        expect(original.destroy).toHaveBeenCalledOnce();
        context.frameGraph.execute();
        expect(encoder.beginRenderPass.mock.calls[1]![0].depthStencilAttachment!.view).toBe(depth._depthView);
        const current = depth._depthTexture!;
        disposeFrameGraphContext(context);
        expect(current.destroy).not.toHaveBeenCalled();
        disposeRenderTarget(depth);
    });

    it("rebinds a standalone clear-to-copy chain to resized ordinary color allocations", () => {
        const { engine, encoder } = mockGpu();
        const source = createRenderTarget({ format: "rgba8unorm", samples: 1, size: engine });
        const output = createRenderTarget({ format: "rgba8unorm", samples: 1, size: engine });
        const clear = createClearTextureTask({ targetTexture: source }, engine);
        const copy = createCopyToTextureTask({ sourceTexture: clear.outputTexture!, targetTexture: output, ownsTargetTexture: true }, engine, {} as SceneContext);
        const context = createFrameGraphContext(engine);
        addTask(context.frameGraph, clear);
        addTask(context.frameGraph, copy);
        registerFrameGraphContext(context);
        const firstSource = source._colorTexture!;
        const firstOutput = output._colorTexture!;
        expect(context.frameGraph.execute()).toBe(0);

        setSurfaceSize(engine, 64, 48);
        expect([source._width, source._height, output._width, output._height]).toEqual([64, 48, 64, 48]);
        expect(firstSource.destroy).toHaveBeenCalledOnce();
        expect(firstOutput.destroy).toHaveBeenCalledOnce();
        expect(context.frameGraph.execute()).toBe(0);
        expect(encoder.copyTextureToTexture).toHaveBeenLastCalledWith({ texture: source._colorTexture, mipLevel: 0 }, { texture: output._colorTexture }, { width: 64, height: 48 });
        const currentSource = source._colorTexture!;
        const currentOutput = output._colorTexture!;
        disposeFrameGraphContext(context);
        expect(currentSource.destroy).not.toHaveBeenCalled();
        expect(currentOutput.destroy).toHaveBeenCalledOnce();
        disposeRenderTarget(source);
    });

    it("refreshes scaled ordinary colors before standalone post-process consumers record on resize", () => {
        const { engine, device, encoder } = mockGpu();
        engine.scRT._colorView = {} as GPUTextureView;
        const source = createRenderTarget({ format: "rgba8unorm", samples: 1, size: { surface: engine, scale: 0.5 } });
        const clear = createClearTextureTask({ targetTexture: source }, engine);
        const consumer = createPostProcessTask(
            {
                sourceTexture: clear.outputTexture!,
                targetTexture: engine.scRT,
                _shader: { fragmentWGSL: wgsl`fn applyPostProcess(c:vec4f,uv:vec2f)->vec4f{return c;}` },
            },
            engine
        );
        const context = createFrameGraphContext(engine);
        addTask(context.frameGraph, clear);
        addTask(context.frameGraph, consumer);
        registerFrameGraphContext(context);
        const original = source._colorTexture!;
        const firstView = source._colorView;
        expect([source._width, source._height]).toEqual([16, 8]);
        expect(Array.from(device.createBindGroup.mock.calls[0]![0].entries)[1]!.resource).toBe(firstView);

        setSurfaceSize(engine, 128, 64);
        expect([source._width, source._height]).toEqual([64, 32]);
        expect(source._colorTexture).not.toBe(original);
        expect(original.destroy).toHaveBeenCalledOnce();
        expect(Array.from(device.createBindGroup.mock.calls[1]![0].entries)[1]!.resource).toBe(source._colorView);
        expect(context.frameGraph.execute()).toBe(1);
        expect(Array.from(encoder.beginRenderPass.mock.calls[0]![0].colorAttachments)[0]!.view).toBe(source._colorView);
        const current = source._colorTexture!;
        disposeFrameGraphContext(context);
        expect(current.destroy).not.toHaveBeenCalled();
        disposeRenderTarget(source);
    });

    it("does not clear an absent aspect and reports detached live attachments", () => {
        const { engine, encoder } = mockGpu();
        const depth = target(engine, { format: undefined, dFormat: "depth32float" });
        const task = createClearTextureTask({ depthTexture: depth, clearStencil: true }, engine);
        const graph = graphFor(task);
        graph.execute();
        expect(encoder.beginRenderPass).not.toHaveBeenCalled();
        task.clearDepth = true;
        disposeRenderTarget(depth);
        expect(() => graph.execute()).toThrow(/no live depth/);
    });

    it("does not read or linearize disabled color state during depth clears", () => {
        const { engine, encoder } = mockGpu();
        let colorReads = 0;
        const color = {
            get r() {
                colorReads++;
                return 0.25;
            },
            g: 0.5,
            b: 0.75,
            a: 1,
        };
        const task = createClearTextureTask(
            {
                targetTexture: target(engine),
                depthTexture: target(engine, { format: undefined, dFormat: "depth32float" }),
                clearColor: false,
                clearDepth: true,
                convertColorToLinearSpace: true,
                color,
            },
            engine
        );
        const graph = graphFor(task);
        graph.execute();
        graph.execute();
        expect(colorReads).toBe(0);
        task.clearColor = true;
        graph.execute();
        expect(colorReads).toBe(1);
        expect(Array.from(encoder.beginRenderPass.mock.calls[2]![0].colorAttachments)[0]!.clearValue).toEqual({
            r: 0.25 ** 2.2,
            g: 0.5 ** 2.2,
            b: 0.75 ** 2.2,
            a: 1,
        });
    });

    it("clears a resized mipmapped producer before generating its mip chain in the same encoder", () => {
        const { engine, encoder, device } = mockGpu();
        const rt = createMipMappedRenderTarget({ format: "rgba8unorm", samples: 1, size: engine });
        const graph = createFrameGraph(engine);
        addTask(graph, createClearTextureTask({ targetTexture: rt }, engine));
        addTask(graph, { name: "allocate", engine, _passes: [], record: () => buildRenderTarget(rt, engine), dispose: () => disposeRenderTarget(rt) });
        addTask(graph, createGenerateMipMapsTask({ targetTexture: rt }, engine));
        graph.build();
        expect(graph.execute()).toBe(5);
        expect(encoder.beginRenderPass).toHaveBeenCalledTimes(6);
        expect(Array.from(encoder.beginRenderPass.mock.calls[0]![0].colorAttachments)[0]!.view).toBe(rt._colorView);
        engine.canvas.width = 64;
        graph.build();
        expect(graph.execute()).toBe(6);
        expect(encoder.beginRenderPass).toHaveBeenCalledTimes(13);
        expect(Array.from(encoder.beginRenderPass.mock.calls[6]![0].colorAttachments)[0]!.view).toBe(rt._colorView);
        expect(device.queue.submit).not.toHaveBeenCalled();
    });
});

describe("GenerateMipMapsTask", () => {
    it("regenerates every mip in the current encoder without per-frame GPU-object creation or submissions", () => {
        const { engine, device, encoder, pass } = mockGpu();
        const tex = texture(engine);
        const task = createGenerateMipMapsTask({ targetTexture: tex }, engine);
        const graph = graphFor(task);
        expect(task.outputTexture).toBe(tex);
        expect(device.createBindGroup).toHaveBeenCalledTimes(5);
        const views = vi
            .mocked(tex.texture.createView)
            .mock.calls.slice(1)
            .map(([view]) => view);
        expect(views).toEqual(
            Array.from({ length: 5 }, (_, i) => [
                { baseMipLevel: i, mipLevelCount: 1, dimension: "2d", baseArrayLayer: 0, arrayLayerCount: 1 },
                { baseMipLevel: i + 1, mipLevelCount: 1, dimension: "2d", baseArrayLayer: 0, arrayLayerCount: 1 },
            ]).flat()
        );
        expect(graph.execute()).toBe(5);
        const descriptors = encoder.beginRenderPass.mock.calls.map(([descriptor]) => descriptor);
        expect(graph.execute()).toBe(5);
        expect(encoder.beginRenderPass.mock.calls.slice(5).map(([descriptor]) => descriptor)).toEqual(descriptors);
        expect(tex.texture.createView).toHaveBeenCalledTimes(11);
        expect(device.createBindGroup).toHaveBeenCalledTimes(5);
        expect(device.createRenderPipeline).toHaveBeenCalledOnce();
        expect(device.createCommandEncoder).not.toHaveBeenCalled();
        expect(device.queue.submit).not.toHaveBeenCalled();
        expect(pass.draw).toHaveBeenCalledTimes(10);
        expect(pass.draw).toHaveBeenCalledWith(3);
        task.executionEnabled = false;
        expect(graph.execute()).toBe(0);
        graph.dispose();
        expect(tex.texture.destroy).not.toHaveBeenCalled();
    });

    it.each([2, 6])("regenerates all %i array/cube layers independently", (layers) => {
        const { engine, device } = mockGpu();
        const tex = texture(engine, { size: { width: 32, height: 16, depthOrArrayLayers: layers } });
        const graph = graphFor(createGenerateMipMapsTask({ targetTexture: tex }, engine));
        expect(graph.execute()).toBe(5 * layers);
        expect(device.createBindGroup).toHaveBeenCalledTimes(5 * layers);
        for (let layer = 0; layer < layers; layer++) {
            expect(
                vi
                    .mocked(tex.texture.createView)
                    .mock.calls.slice(1 + 10 * layer, 11 + 10 * layer)
                    .every(([view]) => view?.baseArrayLayer === layer)
            ).toBe(true);
        }
    });

    it("initializes after target allocation, records dependencies, and rebuilds from replacement textures", () => {
        const { engine, device, encoder } = mockGpu();
        const rt = createMipMappedRenderTarget({ format: "rgba8unorm", samples: 1, size: engine });
        const task = createGenerateMipMapsTask({ targetTexture: rt }, engine);
        const graph = createFrameGraph(engine);
        addTask(graph, task);
        addTask(graph, { name: "allocate", engine, _passes: [], record: () => buildRenderTarget(rt, engine), dispose: () => disposeRenderTarget(rt) });
        graph.build();
        expect(task.outputTexture).toBe(rt);
        expect(task._passes[0]!._dependencies.has(rt)).toBe(true);
        expect(device.createTexture).toHaveBeenCalledOnce();
        expect(graph.execute()).toBe(5);
        const previous = rt._colorTexture!;
        engine.canvas.width = 64;
        graph.build();
        expect(graph.execute()).toBe(6);
        expect(rt._colorTexture).not.toBe(previous);
        expect(encoder.beginRenderPass).toHaveBeenCalledTimes(11);
        graph.dispose();
        expect(previous.destroy).toHaveBeenCalledOnce();
        expect(device.createTexture.mock.results[1]!.value.destroy).toHaveBeenCalledOnce();
    });

    it("permits a 1x1 mip chain as a no-op", () => {
        const { engine, encoder, device } = mockGpu();
        const tex = texture(engine, { size: { width: 1, height: 1 }, mipLevelCount: 1 });
        expect(graphFor(createGenerateMipMapsTask({ targetTexture: tex }, engine)).execute()).toBe(0);
        expect(encoder.beginRenderPass).not.toHaveBeenCalled();
        expect(device.createRenderPipeline).not.toHaveBeenCalled();
    });

    it("rejects disposed render targets before encoding cached mip bindings", () => {
        const { engine, encoder } = mockGpu();
        const rt = createMipMappedRenderTarget({ format: "rgba8unorm", samples: 1, size: engine });
        const graph = graphFor(createGenerateMipMapsTask({ targetTexture: rt }, engine));
        disposeRenderTarget(rt);
        expect(() => graph.execute()).toThrow(/disposed.*rebuild/);
        expect(encoder.beginRenderPass).not.toHaveBeenCalled();
    });

    it("requires rebuilding after a texture facade's backing allocation changes", () => {
        const { engine, encoder } = mockGpu();
        const tex = texture(engine);
        const graph = graphFor(createGenerateMipMapsTask({ targetTexture: tex }, engine));
        const replacement = texture(engine, { mipLevelCount: 3 });
        tex.texture = replacement.texture;
        expect(() => graph.execute()).toThrow(/changed.*rebuild/);
        expect(encoder.beginRenderPass).not.toHaveBeenCalled();
        graph.build();
        expect(graph.execute()).toBe(2);
    });

    it("requires rebuilding when the public target input is replaced", () => {
        const { engine, encoder } = mockGpu();
        const task = createGenerateMipMapsTask({ targetTexture: texture(engine) }, engine);
        const graph = graphFor(task);
        task.targetTexture = texture(engine, { mipLevelCount: 2 });
        expect(() => graph.execute()).toThrow(/changed.*rebuild/);
        expect(encoder.beginRenderPass).not.toHaveBeenCalled();
        graph.build();
        expect(graph.execute()).toBe(1);
    });

    it.each([
        { mipLevelCount: 1 },
        { sampleCount: 4 },
        { dimension: "3d" },
        { dimension: "1d" },
        { format: "depth32float" },
        { format: "rgba8uint" },
        { format: "bc1-rgba-unorm" },
        { format: "rgba32float" },
        { usage: GPUTextureUsage.TEXTURE_BINDING },
        { usage: GPUTextureUsage.RENDER_ATTACHMENT },
    ] satisfies Partial<GPUTextureDescriptor>[])("rejects unsupported mipmap targets: %j", (options) => {
        const { engine, encoder, device } = mockGpu();
        const tex = texture(engine, options);
        expect(() => graphFor(createGenerateMipMapsTask({ targetTexture: tex }, engine))).toThrow(/GenerateMipMapsTask/);
        expect(encoder.beginRenderPass).not.toHaveBeenCalled();
        expect(device.createRenderPipeline).not.toHaveBeenCalled();
    });

    it.each([
        ["rgba32float", "float32-filterable"],
        ["rg11b10ufloat", "rg11b10ufloat-renderable"],
        ["r8snorm", "texture-formats-tier1"],
        ["rg8snorm", "texture-formats-tier1"],
        ["rgba8snorm", "texture-formats-tier1"],
    ] as const)("requires %s's explicit %s feature", (format, feature) => {
        const unsupported = mockGpu();
        expect(() => graphFor(createGenerateMipMapsTask({ targetTexture: texture(unsupported.engine, { format }) }, unsupported.engine))).toThrow(/filterable/);
        const supported = mockGpu([feature]);
        expect(graphFor(createGenerateMipMapsTask({ targetTexture: texture(supported.engine, { format }) }, supported.engine)).execute()).toBe(5);
    });

    it.each(["r16unorm", "r16snorm", "rg16unorm", "rg16snorm", "rgba16unorm", "rgba16snorm"] as const)("rejects unfilterable %s even with texture-formats-tier1", (format) => {
        const { engine, device, encoder } = mockGpu(["texture-formats-tier1"]);
        const tex = texture(engine, { format });
        expect(() => graphFor(createGenerateMipMapsTask({ targetTexture: tex }, engine))).toThrow(/filterable/);
        expect(device.createBindGroup).not.toHaveBeenCalled();
        expect(device.createRenderPipeline).not.toHaveBeenCalled();
        expect(encoder.beginRenderPass).not.toHaveBeenCalled();
        const rt = createMipMappedRenderTarget({ format, samples: 1, size: engine });
        const allocations = device.createTexture.mock.calls.length;
        expect(() => buildRenderTarget(rt, engine)).toThrow(/filterable/);
        expect(device.createTexture).toHaveBeenCalledTimes(allocations);
    });

    it("rejects missing inputs, swapchain targets, and non-mipmapped render targets", () => {
        const { engine } = mockGpu();
        expect(() => graphFor(createGenerateMipMapsTask({ targetTexture: undefined! }, engine))).toThrow(/required/);
        expect(() => graphFor(createGenerateMipMapsTask({ targetTexture: engine.scRT }, engine))).toThrow(/swapchain/);
        expect(() => graphFor(createGenerateMipMapsTask({ targetTexture: target(engine) }, engine))).toThrow(/mipmaps allocated/);
    });
});

describe("Mipmapped render target allocation", () => {
    it("shares color/depth creation with ordinary targets, changing only the color mip count", () => {
        const { engine, device } = mockGpu();
        const descriptor = { lbl: "shared", format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: { width: 32, height: 16 } } as const;
        const plain = createRenderTarget(descriptor);
        const mipmapped = createMipMappedRenderTarget(descriptor);
        buildRenderTarget(plain, engine);
        buildRenderTarget(mipmapped, engine);
        const [plainColor, plainDepth, mipDepth, mipColor] = device.createTexture.mock.calls.map(([options]) => options);
        expect(mipColor).toEqual({ ...plainColor, mipLevelCount: 6 });
        expect(mipDepth).toEqual(plainDepth);
        expect(plain._colorTexture!.mipLevelCount).toBe(1);
        expect(plain._colorTexture!.createView).toHaveBeenCalledExactlyOnceWith();
        expect(mipmapped._colorTexture!.createView).toHaveBeenNthCalledWith(1);
        expect(mipmapped._colorTexture!.createView).toHaveBeenNthCalledWith(2, { baseMipLevel: 0, mipLevelCount: 1 });
        expect(mipmapped._colorSamplingView).toBe(vi.mocked(mipmapped._colorTexture!.createView).mock.results[0]!.value);
        expect(vi.mocked(mipmapped._depthTexture!.createView).mock.calls).toEqual(vi.mocked(plain._depthTexture!.createView).mock.calls);
    });

    it("keeps ordinary MSAA and depth-only allocation descriptors unchanged", () => {
        const { engine, device } = mockGpu();
        const msaa = target(engine, { dFormat: "depth24plus-stencil8", samples: 4 });
        const depth = target(engine, { format: undefined, dFormat: "depth32float" });
        expect(device.createTexture.mock.calls).toHaveLength(3);
        expect(msaa._colorTexture!.sampleCount).toBe(4);
        expect(msaa._depthTexture!.sampleCount).toBe(4);
        expect(msaa._colorTexture!.mipLevelCount).toBe(1);
        expect(device.createTexture.mock.calls[0]![0]).not.toHaveProperty("mipLevelCount");
        expect(msaa._depthTexture!.mipLevelCount).toBe(1);
        expect(depth._colorTexture).toBeNull();
        expect(depth._depthTexture!.mipLevelCount).toBe(1);
        expect(device.createTexture.mock.calls[1]![0]).not.toHaveProperty("mipLevelCount");
        expect(device.createTexture.mock.calls[2]![0]).not.toHaveProperty("mipLevelCount");
    });

    it("allocates a full chain with a mip-0 attachment view and single-level depth, and reuses unchanged builds", () => {
        const { engine, device } = mockGpu();
        const rt = createMipMappedRenderTarget({ format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: { width: 33, height: 17 } });
        expect(device.createTexture).not.toHaveBeenCalled();
        buildRenderTarget(rt, engine);
        expect(rt._colorTexture!.mipLevelCount).toBe(6);
        expect(rt._colorTexture!.createView).toHaveBeenCalledWith({ baseMipLevel: 0, mipLevelCount: 1 });
        expect(rt._depthTexture!.mipLevelCount).toBe(1);
        buildRenderTarget(rt, engine);
        expect(device.createTexture).toHaveBeenCalledTimes(2);
        const color = rt._colorTexture!;
        const depth = rt._depthTexture!;
        disposeRenderTarget(rt);
        disposeRenderTarget(rt);
        expect(color.destroy).toHaveBeenCalledOnce();
        expect(depth.destroy).toHaveBeenCalledOnce();
        expect(rt._colorSamplingView).toBeNull();
        expect(() => buildRenderTarget(rt, engine)).toThrow(/disposed/);
    });

    it("reallocates on scaled-surface resize and device changes", () => {
        const first = mockGpu();
        const rt = createMipMappedRenderTarget({ format: "rgba8unorm", samples: 1, size: { surface: first.engine, scale: 0.5 } });
        buildRenderTarget(rt, first.engine);
        expect([rt._width, rt._height, rt._colorTexture!.mipLevelCount]).toEqual([16, 8, 5]);
        const old = rt._colorTexture!;
        first.engine.canvas.width = 64;
        buildRenderTarget(rt, first.engine);
        expect([rt._width, rt._height, rt._colorTexture!.mipLevelCount]).toEqual([32, 8, 6]);
        expect(old.destroy).toHaveBeenCalledOnce();
        const resized = rt._colorTexture!;
        const next = mockGpu();
        buildRenderTarget(rt, next.engine);
        expect(next.device.createTexture).toHaveBeenCalledOnce();
        expect(resized.destroy).toHaveBeenCalledOnce();
    });

    it("preserves the previous allocation and cleans up unpublished resources if preparation fails", () => {
        const { engine, device, textures } = mockGpu();
        const rt = createMipMappedRenderTarget({ format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: engine });
        buildRenderTarget(rt, engine);
        const oldColor = rt._colorTexture!;
        const oldDepth = rt._depthTexture!;
        const createTexture = device.createTexture.getMockImplementation()!;
        engine.canvas.width = 64;
        device.createTexture.mockImplementation((descriptor) => {
            const tex = createTexture(descriptor);
            if (descriptor.format === "rgba8unorm") {
                vi.mocked(tex.createView).mockImplementation(() => {
                    throw new Error("view failed");
                });
            }
            return tex;
        });
        expect(() => buildRenderTarget(rt, engine)).toThrow("view failed");
        expect(rt._colorTexture).toBe(oldColor);
        expect(rt._depthTexture).toBe(oldDepth);
        expect(rt._width).toBe(32);
        expect(oldColor.destroy).not.toHaveBeenCalled();
        expect(oldDepth.destroy).not.toHaveBeenCalled();
        expect(textures[2]!.destroy).toHaveBeenCalledOnce();
        expect(textures[3]!.destroy).toHaveBeenCalledOnce();
        device.createTexture.mockImplementation(createTexture);
        buildRenderTarget(rt, engine);
        expect(rt._width).toBe(64);
        expect(oldColor.destroy).toHaveBeenCalledOnce();
    });

    it("rejects invalid allocation options without GPU work", () => {
        const { engine, device } = mockGpu();
        expect(() => createMipMappedRenderTarget({ format: "rgba8unorm", samples: 4, size: engine })).toThrow(/samples: 1/);
        expect(() => createMipMappedRenderTarget({ dFormat: "depth32float", samples: 1, size: engine })).toThrow(/color format/);
        const integer = createMipMappedRenderTarget({ format: "rgba8uint", samples: 1, size: engine });
        expect(() => buildRenderTarget(integer, engine)).toThrow(/filterable/);
        const zero = createMipMappedRenderTarget({ format: "rgba8unorm", samples: 1, size: { width: 0, height: 1 } });
        expect(() => buildRenderTarget(zero, engine)).toThrow(/positive integers/);
        expect(device.createTexture).not.toHaveBeenCalled();
    });

    it("rejects an oversized resize before asynchronous GPU validation can replace the valid generation", () => {
        const { engine, device } = mockGpu();
        const rt = createMipMappedRenderTarget({ format: "rgba8unorm", samples: 1, size: engine });
        buildRenderTarget(rt, engine);
        const color = rt._colorTexture;
        const attachmentView = rt._colorView;
        const samplingView = rt._colorSamplingView;
        engine.canvas.width = device.limits.maxTextureDimension2D + 1;
        expect(() => buildRenderTarget(rt, engine)).toThrow(/maxTextureDimension2D/);
        expect(device.createTexture).toHaveBeenCalledOnce();
        expect(rt._colorTexture).toBe(color);
        expect(rt._colorView).toBe(attachmentView);
        expect(rt._colorSamplingView).toBe(samplingView);
        expect(rt._width).toBe(32);
        expect(color!.destroy).not.toHaveBeenCalled();
    });

    it("rebuilds attachment format changes and rejects sample-count changes before reuse", () => {
        const { engine } = mockGpu();
        const descriptor = { format: "rgba8unorm" as GPUTextureFormat, samples: 1, size: engine };
        const rt = createMipMappedRenderTarget(descriptor);
        buildRenderTarget(rt, engine);
        const previous = rt._colorTexture!;
        descriptor.format = "rgba16float";
        buildRenderTarget(rt, engine);
        expect(rt._colorTexture!.format).toBe("rgba16float");
        expect(previous.destroy).toHaveBeenCalledOnce();
        const current = rt._colorTexture;
        descriptor.samples = 4;
        expect(() => buildRenderTarget(rt, engine)).toThrow(/single-sample/);
        expect(rt._colorTexture).toBe(current);
    });

    it("exposes all mip levels to copy blits while using mip 0 for the target attachment", () => {
        const { engine, device, encoder } = mockGpu();
        const source = createMipMappedRenderTarget({ format: "rgba8unorm", samples: 1, size: engine });
        buildRenderTarget(source, engine);
        const destination = target(engine);
        const task = createCopyToTextureTask(
            { sourceTexture: source, targetTexture: destination, lodLevel: 1, viewport: { x: 0, y: 0, width: 1, height: 1 } },
            engine,
            {} as SceneContext
        );
        graphFor(task).execute();
        expect(Array.from(device.createBindGroup.mock.calls[0]![0].entries)[0]!.resource).toBe(source._colorSamplingView);
        expect(source._colorSamplingView).not.toBe(source._colorView);
        expect(Array.from(encoder.beginRenderPass.mock.calls[0]![0].colorAttachments)[0]!.view).toBe(destination._colorView);
    });

    it("exposes full mip chains to the primary and extra post-process samplers", () => {
        const { engine, device } = mockGpu();
        const source = createMipMappedRenderTarget({ format: "rgba8unorm", samples: 1, size: engine });
        const extra = createMipMappedRenderTarget({ format: "rgba8unorm", samples: 1, size: engine });
        buildRenderTarget(source, engine);
        buildRenderTarget(extra, engine);
        const task = createPostProcessTask(
            {
                sourceTexture: source,
                targetTexture: target(engine),
                _shader: { fragmentWGSL: wgsl`fn applyPostProcess(c:vec4f,uv:vec2f)->vec4f{return c;}`, extraTextures: [extra] },
            },
            engine
        );
        graphFor(task).execute();
        const entries = Array.from(device.createBindGroup.mock.calls[0]![0].entries);
        expect(entries[1]!.resource).toBe(source._colorSamplingView);
        expect(entries[2]!.resource).toBe(extra._colorSamplingView);
        expect(entries[1]!.resource).not.toBe(source._colorView);
        expect(entries[2]!.resource).not.toBe(extra._colorView);
    });
});
