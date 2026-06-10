import { describe, expect, it } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createRenderTarget, type RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { createCopyToTextureTask } from "../../../packages/babylon-lite/src/frame-graph/copy-to-texture-task";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage" | "GPUShaderStage" | "GPUTextureUsage"> & {
    GPUBufferUsage?: { UNIFORM: number; COPY_DST: number };
    GPUShaderStage?: { VERTEX: number; FRAGMENT: number };
    GPUTextureUsage?: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number; COPY_DST: number };
};

gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 } as unknown as GPUBufferUsage;
gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 } as unknown as GPUShaderStage;
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4, COPY_SRC: 0x1, COPY_DST: 0x2 } as unknown as GPUTextureUsage;

interface BeginPassCapture {
    descriptors: GPURenderPassDescriptor[];
    viewports: Array<{ x: number; y: number; w: number; h: number }>;
    scissors: Array<{ x: number; y: number; w: number; h: number }>;
    draws: number;
    copies: Array<{ source: GPUImageCopyTexture; target: GPUImageCopyTexture; size: GPUExtent3DStrict }>;
    pipelines: GPURenderPipelineDescriptor[];
}

function makeMockEngine(capture: BeginPassCapture): EngineContext {
    const pass = {
        setViewport: (x: number, y: number, w: number, h: number) => {
            capture.viewports.push({ x, y, w, h });
        },
        setScissorRect: (x: number, y: number, w: number, h: number) => {
            capture.scissors.push({ x, y, w, h });
        },
        setBindGroup: () => undefined,
        setPipeline: () => undefined,
        draw: () => {
            capture.draws++;
        },
        end: () => undefined,
    } as unknown as GPURenderPassEncoder;
    const device = {
        createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => d as unknown as GPUBindGroupLayout,
        createBindGroup: (d: GPUBindGroupDescriptor) => d as unknown as GPUBindGroup,
        createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => d as unknown as GPUPipelineLayout,
        createRenderPipeline: (d: GPURenderPipelineDescriptor) => {
            capture.pipelines.push(d);
            return d as unknown as GPURenderPipeline;
        },
        createShaderModule: (d: GPUShaderModuleDescriptor) => d as unknown as GPUShaderModule,
        createSampler: (d: GPUSamplerDescriptor) => d as unknown as GPUSampler,
        createBuffer: (d: GPUBufferDescriptor) => ({ descriptor: d, destroy: () => undefined }) as unknown as GPUBuffer,
        createTexture: (d: GPUTextureDescriptor) =>
            ({
                descriptor: d,
                format: d.format,
                sampleCount: d.sampleCount ?? 1,
                mipLevelCount: d.mipLevelCount ?? 1,
                createView: () => ({}) as GPUTextureView,
                destroy: () => undefined,
            }) as unknown as GPUTexture,
        queue: { writeBuffer: () => undefined },
    } as unknown as GPUDevice;
    return {
        canvas: { width: 800, height: 600 } as HTMLCanvasElement,
        msaaSamples: 1,
        drawCallCount: 0,
        maxDevicePixelRatio: Infinity,
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
        _device: device,
        _context: { configure: () => undefined } as unknown as GPUCanvasContext,
        format: "bgra8unorm",
        _alphaMode: "opaque",
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
        _currentEncoder: {
            beginRenderPass: (d: GPURenderPassDescriptor) => {
                capture.descriptors.push(d);
                return pass;
            },
            copyTextureToTexture: (source: GPUImageCopyTexture, target: GPUImageCopyTexture, size: GPUExtent3DStrict) => {
                capture.copies.push({ source, target, size });
            },
        } as unknown as GPUCommandEncoder,
        scRT: {
            _colorTexture: { id: "swap-tex" },
            _colorView: { id: "swap" },
            _depthTexture: null,
            _depthView: null,
            _descriptor: { format: "bgra8unorm", samples: 1, size: "canvas" },
            _width: 800,
            _height: 600,
            _eager: true,
        } as unknown as RenderTarget,
        _currentDelta: 0,
        _cbs: [],
    };
}

function makeOffscreenRT(format: GPUTextureFormat, width: number, height: number, sampleCount: 1 | 4 = 1) {
    return createRenderTarget({
        lbl: `rt-${format}-${width}x${height}-${sampleCount}`,
        format: format,
        samples: sampleCount,
        size: { width, height },
    });
}

function buildColor(rt: ReturnType<typeof makeOffscreenRT>, engine: EngineContext, mipLevelCount = 1): void {
    const tex = engine._device.createTexture({
        size: { width: (rt._descriptor.size as { width: number }).width, height: (rt._descriptor.size as { height: number }).height },
        format: rt._descriptor.format!,
        sampleCount: rt._descriptor.samples,
        mipLevelCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    rt._colorTexture = tex;
    rt._colorView = tex.createView();
    const size = rt._descriptor.size as { width: number; height: number };
    rt._width = size.width;
    rt._height = size.height;
}

describe("CopyToTextureTask", () => {
    it("uses the encoder-copy fast path when source/target match", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba8unorm", 64, 32);
        const target = makeOffscreenRT("rgba8unorm", 64, 32);
        buildColor(source, engine);
        buildColor(target, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, targetTexture: target }, engine, scene);
        task.record();
        const drawCount = task.execute!();

        expect(drawCount).toBe(0);
        expect(capture.copies).toHaveLength(1);
        expect(capture.copies[0]!.source.texture).toBe(source._colorTexture);
        expect(capture.copies[0]!.source.mipLevel).toBe(0);
        expect(capture.copies[0]!.target.texture).toBe(target._colorTexture);
        expect(capture.copies[0]!.size).toEqual({ width: 64, height: 32 });
        expect(capture.descriptors).toHaveLength(0);
        expect(capture.draws).toBe(0);
    });

    it("falls back to the blit path when a viewport is supplied", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba8unorm", 64, 32);
        const target = makeOffscreenRT("rgba8unorm", 64, 32);
        buildColor(source, engine);
        buildColor(target, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, targetTexture: target, viewport: { x: 0.25, y: 0.75, width: 0.25, height: 0.25 } }, engine, scene);
        task.record();
        const drawCount = task.execute!();

        expect(drawCount).toBe(1);
        expect(capture.copies).toHaveLength(0);
        expect(capture.descriptors).toHaveLength(1);
        expect(capture.draws).toBe(1);
        // All RTs render upright (row 0 = top of scene), so the BJS-space viewport
        // (y=0 = bottom of target) is converted to pixel-y-top for both offscreen
        // and swapchain targets:
        // x = floor(0.25*64) = 16; yTop = floor(0.75*32) = 24;
        // w = floor(0.50*64) - 16 = 16; h = floor(1.00*32) - 24 = 8;
        // y = h - yTop - vh = 32 - 24 - 8 = 0.
        expect(capture.viewports[0]).toEqual({ x: 16, y: 0, w: 16, h: 8 });
        expect(capture.scissors[0]).toEqual({ x: 16, y: 0, w: 16, h: 8 });
    });

    it("falls back to the blit path when format or size differ", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba16float", 64, 32);
        const target = makeOffscreenRT("bgra8unorm", 64, 32);
        buildColor(source, engine);
        buildColor(target, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, targetTexture: target }, engine, scene);
        task.record();
        const drawCount = task.execute!();

        expect(drawCount).toBe(1);
        expect(capture.copies).toHaveLength(0);
        expect(capture.descriptors).toHaveLength(1);
    });

    it("falls back to the blit path when source and target sampleCount differ", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba8unorm", 64, 32, 4);
        const target = makeOffscreenRT("rgba8unorm", 64, 32);
        buildColor(source, engine);
        buildColor(target, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, targetTexture: target }, engine, scene);
        task.record();
        const drawCount = task.execute!();

        expect(drawCount).toBe(1);
        expect(capture.copies).toHaveLength(0);
        expect(capture.draws).toBe(1);
        // Pipeline's multisample count must match the (single-sampled) target.
        const pipeline = capture.pipelines.at(-1)!;
        expect(pipeline.multisample?.count ?? 1).toBe(1);
    });

    it("uses the encoder-copy fast path when source and target are both MSAA with matching sampleCount", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba8unorm", 64, 32, 4);
        const target = makeOffscreenRT("rgba8unorm", 64, 32, 4);
        buildColor(source, engine);
        buildColor(target, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, targetTexture: target }, engine, scene);
        task.record();
        const drawCount = task.execute!();

        expect(drawCount).toBe(0);
        expect(capture.copies).toHaveLength(1);
        expect(capture.copies[0]!.source.texture).toBe(source._colorTexture);
        expect(capture.copies[0]!.target.texture).toBe(target._colorTexture);
        expect(capture.pipelines).toHaveLength(0);
    });

    it("falls back to the blit path with a single-sample source and MSAA target", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba8unorm", 64, 32);
        const target = makeOffscreenRT("rgba8unorm", 64, 32, 4);
        buildColor(source, engine);
        buildColor(target, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, targetTexture: target }, engine, scene);
        task.record();
        const drawCount = task.execute!();

        expect(drawCount).toBe(1);
        // Pipeline's multisample count must match the MSAA target.
        const pipeline = capture.pipelines.at(-1)!;
        expect(pipeline.multisample?.count).toBe(4);
    });

    it("blits to the swapchain view when target is the engine scRT", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("bgra8unorm", 64, 32);
        const swapTarget = engine.scRT;
        buildColor(source, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, targetTexture: swapTarget }, engine, scene);
        task.record();
        const drawCount = task.execute!();

        expect(drawCount).toBe(1);
        const desc = capture.descriptors[0]!;
        const att = (desc.colorAttachments as GPURenderPassColorAttachment[])[0]!;
        // sampleCount=1 scRT: view re-read from scRT._colorView per frame
        expect(att.view).toBe(engine.scRT._colorView);
    });

    it("exposes targetTexture as outputTexture", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba8unorm", 64, 32);
        const target = makeOffscreenRT("rgba8unorm", 64, 32);

        const task = createCopyToTextureTask({ sourceTexture: source, targetTexture: target }, engine, scene);
        expect(task.outputTexture).toBe(target);
    });

    it("falls back to the blit path when lodLevel'd source mip size doesn't match target", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba8unorm", 64, 32);
        const target = makeOffscreenRT("rgba8unorm", 64, 32);
        buildColor(source, engine);
        buildColor(target, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, targetTexture: target, lodLevel: 2 }, engine, scene);
        task.record();
        const drawCount = task.execute!();

        expect(drawCount).toBe(1);
        expect(capture.copies).toHaveLength(0);
    });

    it("uses the encoder-copy fast path with lodLevel > 0 when the source mip size matches the target", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba8unorm", 64, 32);
        const target = makeOffscreenRT("rgba8unorm", 16, 8);
        buildColor(source, engine, 4);
        buildColor(target, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, targetTexture: target, lodLevel: 2 }, engine, scene);
        task.record();
        const drawCount = task.execute!();

        expect(drawCount).toBe(0);
        expect(capture.copies).toHaveLength(1);
        expect(capture.copies[0]!.source.texture).toBe(source._colorTexture);
        expect(capture.copies[0]!.source.mipLevel).toBe(2);
        expect(capture.copies[0]!.target.texture).toBe(target._colorTexture);
        expect(capture.copies[0]!.size).toEqual({ width: 16, height: 8 });
        expect(capture.pipelines).toHaveLength(0);
    });

    it("falls back to the blit path when lodLevel is out of source mip range", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba8unorm", 16, 8);
        const target = makeOffscreenRT("rgba8unorm", 16, 8);
        buildColor(source, engine, 1);
        buildColor(target, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, targetTexture: target, lodLevel: 1 }, engine, scene);
        task.record();
        const drawCount = task.execute!();

        expect(drawCount).toBe(1);
        expect(capture.copies).toHaveLength(0);
    });

    it("hardware-resolves MSAA source into resolveTexture via a draw-less render pass", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba8unorm", 64, 32, 4);
        const resolve = makeOffscreenRT("rgba8unorm", 64, 32, 1);
        buildColor(source, engine);
        buildColor(resolve, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, resolveTexture: resolve }, engine, scene);
        task.record();
        const drawCount = task.execute!();

        expect(drawCount).toBe(0);
        expect(capture.copies).toHaveLength(0);
        expect(capture.descriptors).toHaveLength(1);
        expect(capture.pipelines).toHaveLength(0);
        expect(capture.draws).toBe(0);

        const att = (capture.descriptors[0]!.colorAttachments as GPURenderPassColorAttachment[])[0]!;
        expect(att.view).toBe(source._colorView);
        expect(att.resolveTarget).toBe(resolve._colorView);
        expect(att.loadOp).toBe("load");
        expect(att.storeOp).toBe("store");

        expect(task.outputTexture).toBe(resolve);
    });

    it("hardware-resolves MSAA source into the scRT resolveTexture, re-reading the swap view per frame", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("bgra8unorm", 64, 32, 4);
        const swap = engine.scRT;
        buildColor(source, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, resolveTexture: swap }, engine, scene);
        task.record();
        const drawCount = task.execute!();

        expect(drawCount).toBe(0);
        const att = (capture.descriptors[0]!.colorAttachments as GPURenderPassColorAttachment[])[0]!;
        expect(att.view).toBe(source._colorView);
        expect(att.resolveTarget).toBe(engine.scRT._colorView);
    });

    it("rejects resolveTexture when the source is single-sampled", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba8unorm", 64, 32);
        const resolve = makeOffscreenRT("rgba8unorm", 64, 32);
        buildColor(source, engine);
        buildColor(resolve, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, resolveTexture: resolve }, engine, scene);
        expect(() => task.record()).toThrow(/multisampled sourceTexture/);
    });

    it("rejects resolveTexture when source/resolve dimensions mismatch", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba8unorm", 64, 32, 4);
        const resolve = makeOffscreenRT("rgba8unorm", 32, 16);
        buildColor(source, engine);
        buildColor(resolve, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, resolveTexture: resolve }, engine, scene);
        expect(() => task.record()).toThrow(/matching dimensions/);
    });

    it("throws when neither targetTexture nor resolveTexture is provided", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba8unorm", 64, 32);

        expect(() => createCopyToTextureTask({ sourceTexture: source }, engine, scene)).toThrow(/targetTexture or resolveTexture/);
    });

    it("blits to MSAA target and end-of-pass resolves into the SS resolveTexture", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba8unorm", 64, 32);
        const target = makeOffscreenRT("rgba8unorm", 64, 32, 4);
        const resolve = makeOffscreenRT("rgba8unorm", 64, 32, 1);
        buildColor(source, engine);
        buildColor(target, engine);
        buildColor(resolve, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, targetTexture: target, resolveTexture: resolve }, engine, scene);
        task.record();
        const drawCount = task.execute!();

        // Blit still draws (1 fullscreen triangle), and the resolve fires at end-of-pass.
        expect(drawCount).toBe(1);
        expect(capture.draws).toBe(1);
        expect(capture.copies).toHaveLength(0);
        expect(capture.descriptors).toHaveLength(1);

        const att = (capture.descriptors[0]!.colorAttachments as GPURenderPassColorAttachment[])[0]!;
        expect(att.view).toBe(target._colorView);
        expect(att.resolveTarget).toBe(resolve._colorView);

        // The pipeline's multisample count must match the MSAA target.
        const pipeline = capture.pipelines.at(-1)!;
        expect(pipeline.multisample?.count).toBe(4);

        // outputTexture should expose the (post-resolve) single-sample texture.
        expect(task.outputTexture).toBe(resolve);
    });

    it("blits to MSAA target and end-of-pass resolves into the scRT resolveTexture", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("bgra8unorm", 64, 32);
        const target = makeOffscreenRT("bgra8unorm", 64, 32, 4);
        const swap = engine.scRT;
        buildColor(source, engine);
        buildColor(target, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, targetTexture: target, resolveTexture: swap }, engine, scene);
        task.record();
        const drawCount = task.execute!();

        expect(drawCount).toBe(1);
        const att = (capture.descriptors[0]!.colorAttachments as GPURenderPassColorAttachment[])[0]!;
        expect(att.view).toBe(target._colorView);
        expect(att.resolveTarget).toBe(engine.scRT._colorView);
    });

    it("rejects targetTexture+resolveTexture when target is single-sampled", () => {
        const capture: BeginPassCapture = { descriptors: [], viewports: [], scissors: [], draws: 0, copies: [], pipelines: [] };
        const engine = makeMockEngine(capture);
        const scene = createSceneContext(engine) as SceneContext;
        const source = makeOffscreenRT("rgba8unorm", 64, 32);
        const target = makeOffscreenRT("rgba8unorm", 64, 32, 1);
        const resolve = makeOffscreenRT("rgba8unorm", 64, 32, 1);
        buildColor(source, engine);
        buildColor(target, engine);
        buildColor(resolve, engine);

        const task = createCopyToTextureTask({ sourceTexture: source, targetTexture: target, resolveTexture: resolve }, engine, scene);
        expect(() => task.record()).toThrow(/multisampled targetTexture/);
    });
});
