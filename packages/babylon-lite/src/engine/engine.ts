import type { SceneContext } from "../scene/scene.js";
import type { SceneContextInternal } from "../scene/scene.js";
import { processMaterialSwaps, drainSceneBuilders } from "../scene/scene.js";

/** Babylon Lite version string. */
export const VERSION = "0.1.0";

/** Handle to the WebGPU engine — pure state, no attached methods. */
export interface EngineContext {
    readonly canvas: HTMLCanvasElement;
    readonly msaaSamples: number;
    /** Preferred GPU texture format for the swapchain. Use as the `colorFormat`
     *  for offscreen RTs that are sampled by main-pass materials. */
    readonly format: GPUTextureFormat;

    /** Number of GPU draw calls in the last rendered frame. */
    drawCallCount: number;
}

/** @internal Engine with GPU internals exposed. Not re-exported from index.ts. */
export interface EngineContextInternal extends EngineContext {
    readonly device: GPUDevice;
    readonly context: GPUCanvasContext;
    /** Swapchain texture view for the current frame. Refreshed at the start of each RAF. */
    _swapChainView: GPUTextureView | null;
    _animFrameId: number;
    _renderFn: ((now: number) => void) | null;
    /** True when the frame graph needs to be (re)built before the next execute().
     *  Initially true so the first frame builds; set true on canvas resize. */
    _needsBuild: boolean;
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

    const engine: EngineContextInternal = {
        device,
        context,
        format,
        canvas,
        msaaSamples,
        drawCallCount: 0,
        _swapChainView: null,
        _animFrameId: 0,
        _renderFn: null,
        _needsBuild: true,
    };

    return engine;
}

/** If the canvas has been resized, reconfigure the swapchain backing-store size and
 *  flag the engine for a frame graph rebuild on the next renderFrame. */
function handleResize(eng: EngineContextInternal): void {
    const canvas = eng.canvas;
    const w = (canvas.clientWidth * devicePixelRatio) | 0;
    const h = (canvas.clientHeight * devicePixelRatio) | 0;
    if (w === canvas.width && h === canvas.height) {
        return;
    }
    canvas.width = w;
    canvas.height = h;
    eng._needsBuild = true;
}

/** Encode + submit a single frame: drain scene builders, resize, build if needed,
 *  acquire swapchain, run scene callbacks, execute the frame graph. */
async function renderFrame(eng: EngineContextInternal, sc: SceneContextInternal, deltaMs: number): Promise<void> {
    // Scene authoring may have queued builders (mesh-group batch builds, env background
    // setup, addToPass overrides). Drain them BEFORE building the frame graph so that
    // task.record() sees a fully populated scene._renderables.
    if (sc._builders.length > 0) {
        await drainSceneBuilders(sc);
        eng._needsBuild = true;
    }

    handleResize(eng);

    if (eng._needsBuild) {
        await sc._frameGraph.build();
        eng._needsBuild = false;
    }

    // Acquire the swapchain view for this frame and expose it on the engine
    // context so frame graph tasks can read it without explicit threading.
    eng._swapChainView = eng.context.getCurrentTexture().createView();

    for (const cb of sc._beforeRender) {
        cb(deltaMs);
    }
    if (sc._materialSwapQueue.length > 0) {
        processMaterialSwaps(sc);
    }
    // Internal per-frame callbacks (lights UBO refresh, mesh-group GPU updates, etc.) —
    // run after user-facing _beforeRender (which may have mutated transforms/lights)
    // and before the frame graph executes.
    for (const cb of sc._perFrameCallbacks) {
        cb();
    }
    sc._frameGraph.execute();
}

/** Start the render loop for the given scene. Resolves after the first frame has been rendered. */
export function startEngine(engine: EngineContext, scene: SceneContext): Promise<void> {
    const eng = engine as EngineContextInternal;
    const sc = scene as SceneContextInternal;
    return new Promise<void>((resolve) => {
        let lastTime = 0;
        let firstFrame = true;
        eng._renderFn = (now: number) => {
            // First frame: delta=0 (matches Babylon.js _localDelayOffset which
            // absorbs the first accumulated deltaTime, so frame 1 evaluates at t=0)
            const delta = firstFrame ? 0 : sc._fixedDeltaMs > 0 ? sc._fixedDeltaMs : lastTime > 0 ? now - lastTime : 16.667;
            lastTime = now;

            void renderFrame(eng, sc, delta).then(() => {
                if (firstFrame) {
                    firstFrame = false;
                    // Signal first-frame paint to the lab loader overlay so it can dismiss
                    // even when scenes delay data-ready (e.g. physics settling).
                    if (eng.canvas && eng.canvas.dataset) {
                        eng.canvas.dataset.loaded = "true";
                    }
                    resolve();
                }
                eng._animFrameId = requestAnimationFrame(eng._renderFn!);
            });
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
    await renderFrame(eng, sc, 0);
    await eng.device.queue.onSubmittedWorkDone();
}

/** Release all engine-owned GPU resources (render targets, device). */
export function disposeEngine(engine: EngineContext, scene?: SceneContext): void {
    const eng = engine as EngineContextInternal;
    stopEngine(engine);
    if (scene) {
        (scene as SceneContextInternal)._frameGraph.dispose();
    }
    eng.context.unconfigure();
    eng.device.destroy();
}
