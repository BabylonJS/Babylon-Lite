/** Babylon Lite version string. */
export const VERSION = "0.1.0";

// Module-scoped visibility epoch. setSubtreeVisible (scene/visibility.ts,
// loaded only by KHR_node_visibility / KHR_animation_pointer features) bumps
// this. Per-scene bundle caches compare against it for invalidation.
export let _vis = 0;
export function bumpVisibilityEpoch(): void {
    _vis = (_vis + 1) | 0;
}

/** Handle to the WebGPU engine — pure state, no attached methods. */
export interface EngineContext {
    readonly canvas: HTMLCanvasElement;
    readonly msaaSamples: number;

    /** Number of GPU draw calls in the last rendered frame. */
    drawCallCount: number;
}

/**
 * Minimal surface an engine sees for anything it renders. Scenes (and any other
 * future renderable thing) register themselves as a `RenderingContext` and
 * own their own update / record logic. Engine knows nothing of scene internals.
 */
/**
 * Minimal surface an engine sees for anything it renders. Scenes (and any other
 * future renderable thing) register themselves as a `RenderingContext` and
 * own their own update / record logic. Engine knows nothing of scene internals.
 */
export interface RenderingContext {
    /** Draw calls produced by pre-pass work during `_update` (shadows + pre-passes). */
    _drawCallsPre: number;
    /** Clear color used when this context is the first active one in a frame. */
    clearColor: GPUColorDict;
    /** Run per-frame update work (beforeRender hooks, shadow + pre-passes, UBO updates,
     *  transparent sort, and any user _beforeMain hook). May finish+submit `encoder`
     *  and return a new one. */
    _update(encoder: GPUCommandEncoder, delta: number): GPUCommandEncoder;
    /** Record main-pass draws into `pass`. Returns draw-call count. */
    _record(pass: GPURenderPassEncoder): number;
}

/** @internal Engine with GPU internals exposed. Not re-exported from index.ts. */
export interface EngineContextInternal extends EngineContext {
    readonly device: GPUDevice;
    readonly context: GPUCanvasContext;
    readonly format: GPUTextureFormat;
    _targets: RenderTargets;
    _animFrameId: number;
    _renderFn: ((now: number) => void) | null;
    /** Registered rendering contexts in render order (first clears; subsequent overlay). */
    _renderingContexts: RenderingContext[];
}

interface RenderTargets {
    // Null when MSAA is disabled (sampleCount === 1): we render directly into the
    // swapchain texture without a resolve step.
    msaaTexture: GPUTexture | null;
    msaaView: GPUTextureView | null;
    depthTexture: GPUTexture;
    depthView: GPUTextureView;
    width: number;
    height: number;
}

/**
 * Options for `createEngine`.
 * - `msaaSamples`: number of MSAA samples to use for the main render pass.
 *   WebGPU only permits `1` (no MSAA) or `4` (4x MSAA) per the spec
 *   (2x is not a valid WebGPU sample count). Defaults to `4`.
 */
export interface EngineOptions {
    msaaSamples?: 1 | 4;
}

/** Create the Babylon Lite engine. Acquires GPU adapter + device, configures swapchain. */
export async function createEngine(canvas: HTMLCanvasElement, options?: EngineOptions): Promise<EngineContext> {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
        throw new Error("WebGPU adapter not available");
    }

    const features: GPUFeatureName[] = [];
    if (adapter.features.has("float32-filterable")) {
        features.push("float32-filterable");
    }
    for (const f of ["texture-compression-astc", "texture-compression-bc", "texture-compression-etc2"] as GPUFeatureName[]) {
        if (adapter.features.has(f)) {
            features.push(f);
        }
    }
    const device = await adapter.requestDevice({ requiredFeatures: features });
    const context = canvas.getContext("webgpu");
    if (!context) {
        throw new Error("WebGPU context not available");
    }

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });

    const versionToLog = `Babylon Lite v${VERSION}`;
    // eslint-disable-next-line no-console
    console.log(`${versionToLog} - WebGPU engine`);
    if (canvas.setAttribute) {
        canvas.setAttribute("data-engine", versionToLog);
    }

    const msaaSamples: 1 | 4 = options?.msaaSamples === 1 ? 1 : 4;

    const targets = createRenderTargets(device, canvas.width, canvas.height, format, msaaSamples);
    const engine: EngineContextInternal = {
        device,
        context,
        format,
        canvas,
        msaaSamples,
        drawCallCount: 0,
        _targets: targets,
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
    };

    return engine;
}

/** Resize render targets to match canvas size. */
export function resizeEngine(engine: EngineContext): void {
    const eng = engine as EngineContextInternal;
    const canvas = eng.canvas;
    const w = (canvas.clientWidth * devicePixelRatio) | 0;
    const h = (canvas.clientHeight * devicePixelRatio) | 0;
    if (w === eng._targets.width && h === eng._targets.height) {
        return;
    }
    canvas.width = w;
    canvas.height = h;
    eng.context.configure({ device: eng.device, format: eng.format, alphaMode: "opaque" });
    if (eng._targets.msaaTexture) {
        eng._targets.msaaTexture.destroy();
    }
    eng._targets.depthTexture.destroy();
    eng._targets = createRenderTargets(eng.device, w, h, eng.format, eng.msaaSamples);
}

/**
 * Start the render loop. Resolves after the first frame has been rendered.
 * Scenes registered via `registerScene()` before this call are included in
 * the first frame; later registrations join on subsequent frames.
 */
export function startEngine(engine: EngineContext): Promise<void> {
    const eng = engine as EngineContextInternal;
    return new Promise<void>((resolve) => {
        let firstRafFrame = true;
        let lastTime = 0;
        eng._renderFn = (now: number) => {
            const delta = firstRafFrame ? 0 : lastTime > 0 ? now - lastTime : 16.667;
            lastTime = now;
            resizeEngine(engine);
            renderFrame(eng, delta);
            if (firstRafFrame) {
                firstRafFrame = false;
                resolve();
            }
            eng._animFrameId = requestAnimationFrame(eng._renderFn!);
        };
        eng._animFrameId = requestAnimationFrame(eng._renderFn);
    });
}

/** Stop the render loop. */
export function stopEngine(engine: EngineContext): void {
    const eng = engine as EngineContextInternal;
    if (eng._animFrameId) {
        cancelAnimationFrame(eng._animFrameId);
    }
    eng._animFrameId = 0;
    eng._renderFn = null;
}

/** Release all engine-owned GPU resources (render targets, device). */
export function disposeEngine(engine: EngineContext): void {
    const eng = engine as EngineContextInternal;
    stopEngine(engine);
    eng._renderingContexts.length = 0;
    if (eng._targets.msaaTexture) {
        eng._targets.msaaTexture.destroy();
    }
    eng._targets.depthTexture.destroy();
    eng.context.unconfigure();
    eng.device.destroy();
}

function createRenderTargets(device: GPUDevice, width: number, height: number, format: GPUTextureFormat, sampleCount: number): RenderTargets {
    const msaaTexture =
        sampleCount > 1
            ? device.createTexture({
                  size: { width, height },
                  format,
                  sampleCount,
                  usage: GPUTextureUsage.RENDER_ATTACHMENT,
              })
            : null;
    const depthTexture = device.createTexture({
        size: { width, height },
        format: "depth24plus-stencil8",
        sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return {
        msaaTexture,
        msaaView: msaaTexture ? msaaTexture.createView() : null,
        depthTexture,
        depthView: depthTexture.createView(),
        width,
        height,
    };
}

function renderFrame(engine: EngineContextInternal, delta: number): void {
    const targets = engine._targets;
    const ctxs = engine._renderingContexts;

    let encoder = engine.device.createCommandEncoder();
    let drawCalls = 0;
    let rendered = 0;

    const hasMsaa = targets.msaaView !== null;
    const colorAtt: GPURenderPassColorAttachment = {
        view: hasMsaa ? targets.msaaView! : (undefined as unknown as GPUTextureView),
        resolveTarget: undefined,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
    };
    const desc: GPURenderPassDescriptor = {
        colorAttachments: [colorAtt],
        depthStencilAttachment: {
            view: targets.depthView,
            depthClearValue: 1.0,
            depthLoadOp: "clear",
            depthStoreOp: "store",
            stencilClearValue: 0,
            stencilLoadOp: "clear",
            stencilStoreOp: "store",
        },
    };

    for (let i = 0; i < ctxs.length; i++) {
        const s = ctxs[i]!;
        encoder = s._update(encoder, delta);
        drawCalls += s._drawCallsPre;
        if (rendered === 0) {
            const swapView = engine.context.getCurrentTexture().createView();
            if (hasMsaa) {
                colorAtt.resolveTarget = swapView;
            } else {
                colorAtt.view = swapView;
            }
            colorAtt.clearValue = s.clearColor;
        } else {
            colorAtt.loadOp = "load";
        }
        rendered++;

        const pass = encoder.beginRenderPass(desc);
        drawCalls += s._record(pass);
        pass.end();
    }

    engine.device.queue.submit([encoder.finish()]);
    engine.drawCallCount = drawCalls;
}
