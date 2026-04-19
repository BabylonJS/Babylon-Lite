import type { SceneContext } from "../scene/scene.js";
import type { SceneContextInternal } from "../scene/scene.js";
import { buildScene, processMaterialSwaps } from "../scene/scene.js";
import type { Renderable } from "../render/renderable.js";

/** Babylon Lite version string. */
export const VERSION = "0.1.0";

/** Handle to the WebGPU engine — pure state, no attached methods. */
export interface EngineContext {
    readonly canvas: HTMLCanvasElement;
    readonly msaaSamples: number;

    /** Number of GPU draw calls in the last rendered frame. */
    drawCallCount: number;
}

/** @internal Engine with GPU internals exposed. Not re-exported from index.ts. */
export interface EngineContextInternal extends EngineContext {
    readonly device: GPUDevice;
    readonly context: GPUCanvasContext;
    readonly format: GPUTextureFormat;
    _targets: RenderTargets;
    _animFrameId: number;
    _renderFn: ((now: number) => void) | null;
    _opaqueBundle: GPURenderBundle | null;
    _bundleVersion: number;
}

interface RenderTargets {
    msaaTexture: GPUTexture;
    msaaView: GPUTextureView;
    depthTexture: GPUTexture;
    depthView: GPUTextureView;
    width: number;
    height: number;
}

/** Create the Babylon Lite engine. Acquires GPU adapter + device, configures swapchain. */
export async function createEngine(canvas: HTMLCanvasElement): Promise<EngineContext> {
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

    const msaaSamples = 4;

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
        _opaqueBundle: null,
        _bundleVersion: -1,
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
    eng._targets.msaaTexture.destroy();
    eng._targets.depthTexture.destroy();
    eng._targets = createRenderTargets(eng.device, w, h, eng.format, eng.msaaSamples);
}

/** Start the render loop for the given scene. Resolves after the first frame has been rendered. */
export function startEngine(engine: EngineContext, scene: SceneContext): Promise<void> {
    const eng = engine as EngineContextInternal;
    const sc = scene as SceneContextInternal;
    return new Promise<void>((resolve) => {
        const boot = async () => {
            // Run deferred builders (entities register these at add/load time)
            await buildScene(scene);
            // Split renderables: transparent → back-to-front each frame, transmissive → opaque but sampled,
            // everything else → opaque-opaque.
            for (const r of sc._renderables) {
                const bucket = r.isTransparent ? sc._transparentRenderables : r.isTransmissive ? sc._transmissiveRenderables : sc._opaqueRenderables;
                bucket.push(r);
            }
            sc._opaqueRenderables.sort((a, b) => a.order - b.order);
            sc._transmissiveRenderables.sort((a, b) => a.order - b.order);
            // Also keep _renderables sorted for pre-passes and legacy consumers
            sc._renderables.sort((a, b) => a.order - b.order);

            let lastTime = 0;
            let firstFrame = true;
            eng._renderFn = (now: number) => {
                // First frame: delta=0 (matches Babylon.js _localDelayOffset which
                // absorbs the first accumulated deltaTime, so frame 1 evaluates at t=0)
                const delta = firstFrame ? 0 : sc._fixedDeltaMs > 0 ? sc._fixedDeltaMs : lastTime > 0 ? now - lastTime : 16.667;
                lastTime = now;
                resizeEngine(engine);
                for (const cb of sc._beforeRender) {
                    cb(delta);
                }
                if (sc._materialSwapQueue.length > 0) {
                    processMaterialSwaps(scene);
                }
                renderFrame(eng, eng._targets, sc);
                if (firstFrame) {
                    firstFrame = false;
                    resolve();
                }
                eng._animFrameId = requestAnimationFrame(eng._renderFn!);
            };
            eng._animFrameId = requestAnimationFrame(eng._renderFn);
        };
        void boot();
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

/**
 * Render a single frame synchronously (CPU-side command encoding + submit).
 * The caller is responsible for calling this outside the RAF loop — use
 * `stopEngine()` first if the loop is running.
 *
 * Returns a promise that resolves after the GPU has finished executing
 * the submitted commands (`device.queue.onSubmittedWorkDone`).
 */
export async function renderOneFrame(engine: EngineContext, scene: SceneContext): Promise<void> {
    const eng = engine as EngineContextInternal;
    const sc = scene as SceneContextInternal;
    resizeEngine(engine);
    for (const cb of sc._beforeRender) {
        cb(0);
    }
    if (sc._materialSwapQueue.length > 0) {
        processMaterialSwaps(scene);
    }
    renderFrame(eng, eng._targets, sc);
    await eng.device.queue.onSubmittedWorkDone();
}

/** Release all engine-owned GPU resources (render targets, device). */
export function disposeEngine(engine: EngineContext): void {
    const eng = engine as EngineContextInternal;
    stopEngine(engine);
    eng._targets.msaaTexture.destroy();
    eng._targets.depthTexture.destroy();
    eng.context.unconfigure();
    // Pipeline caches auto-clear on device change (no side-effect registry needed)
    eng.device.destroy();
}

function createRenderTargets(device: GPUDevice, width: number, height: number, format: GPUTextureFormat, sampleCount: number): RenderTargets {
    const msaaTexture = device.createTexture({
        size: { width, height },
        format,
        sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const depthTexture = device.createTexture({
        size: { width, height },
        format: "depth24plus-stencil8",
        sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return {
        msaaTexture,
        msaaView: msaaTexture.createView(),
        depthTexture,
        depthView: depthTexture.createView(),
        width,
        height,
    };
}

function drawList(enc: GPURenderPassEncoder | GPURenderBundleEncoder, list: readonly Renderable[], engine: EngineContextInternal): number {
    let lp: GPURenderPipeline | null = null;
    let lb: GPUBindGroup | null = null;
    let draws = 0;
    for (const r of list) {
        if (r._pipeline && r._pipeline !== lp) {
            enc.setPipeline(r._pipeline);
            lp = r._pipeline;
        }
        if (r._sceneBG && r._sceneBG !== lb) {
            enc.setBindGroup(0, r._sceneBG);
            lb = r._sceneBG;
        }
        draws += r.draw(enc, engine);
    }
    return draws;
}

function renderFrame(engine: EngineContextInternal, targets: RenderTargets, scene: SceneContextInternal): void {
    let encoder = engine.device.createCommandEncoder();

    // Pre-passes: shadow maps from lights that have shadow generators
    let drawCalls = 0;
    for (const light of scene.lights) {
        const sg = light.shadowGenerator;
        if (sg) {
            drawCalls += sg.renderShadowMap(encoder);
        }
    }
    // Additional pre-passes (compute, etc.)
    for (const pp of scene._prePasses) {
        drawCalls += pp.execute(encoder, engine);
    }

    // Update scene uniforms (one per shared UBO)
    for (const u of scene._uniformUpdaters) {
        u.update(engine);
    }

    // Update per-mesh UBOs (world matrices) for dynamic transforms — iterates the
    // pre-built renderables union so we pay one loop regardless of opaque/transmissive/transparent split.
    for (const r of scene._renderables) {
        if (r.updateUBOs) {
            r.updateUBOs();
        }
    }

    // Per-frame transparent sort by camera distance (back-to-front)
    const cam = scene.camera;
    if (scene._transparentRenderables.length > 1 && cam) {
        const w = cam.worldMatrix;
        const cx = w[12]!,
            cy = w[13]!,
            cz = w[14]!;
        for (const r of scene._transparentRenderables) {
            if (r._worldCenter) {
                const [wx, wy, wz] = r._worldCenter;
                r._sortDistance = (wx - cx) ** 2 + (wy - cy) ** 2 + (wz - cz) ** 2;
            }
        }
        scene._transparentRenderables.sort((a, b) => (b._sortDistance ?? 0) - (a._sortDistance ?? 0) || a.order - b.order);
    }

    // Lazy hook: refraction/transmission module inserts the opaque-scene RTT + mipmap submit here,
    // then hands back a fresh encoder that the main pass uses. Also lets the hook decide when to
    // acquire the swap-chain view (late, after mid-frame submit).
    if (scene._beforeMain) {
        encoder = scene._beforeMain(engine, scene, encoder);
    }
    const swapChainView = engine.context.getCurrentTexture().createView();

    const pass = encoder.beginRenderPass({
        colorAttachments: [
            {
                view: targets.msaaView,
                resolveTarget: swapChainView,
                clearValue: scene.clearColor,
                loadOp: "clear",
                storeOp: "store",
            },
        ],
        depthStencilAttachment: {
            view: targets.depthView,
            depthClearValue: 1.0,
            depthLoadOp: "clear",
            depthStoreOp: "store",
            stencilClearValue: 0,
            stencilLoadOp: "clear",
            stencilStoreOp: "store",
        },
    });

    pass.setViewport(0, 0, targets.width, targets.height, 0, 1);

    // ─── Opaque pass: use cached render bundle when renderable list is unchanged ───
    if (engine._bundleVersion !== scene._renderableVersion || !engine._opaqueBundle) {
        const bundleEncoder = engine.device.createRenderBundleEncoder({
            colorFormats: [engine.format],
            depthStencilFormat: "depth24plus-stencil8",
            sampleCount: engine.msaaSamples,
        });
        drawList(bundleEncoder, scene._opaqueRenderables, engine);
        engine._opaqueBundle = bundleEncoder.finish();
        engine._bundleVersion = scene._renderableVersion;
    }
    drawCalls += scene._opaqueRenderables.length;
    pass.executeBundles([engine._opaqueBundle]);

    // ─── Transmissive pass: direct-encoded after opaque, before transparent ───
    drawCalls += drawList(pass, scene._transmissiveRenderables, engine);

    // ─── Transparent pass: direct-encoded (re-sorted every frame) ───
    drawCalls += drawList(pass, scene._transparentRenderables, engine);

    pass.end();
    engine.device.queue.submit([encoder.finish()]);
    engine.drawCallCount = drawCalls;
}
