/**
 * Scene2DContext render loop.
 *
 * `startEngine2D`:
 *   1. Run deferred builders — one per Sprite2DLayer. Each builder dynamic-imports
 *      the renderable module (so a 3D-only app pays zero sprite bytes).
 *   2. Start the rAF loop: tick clips, update per-layer scene UBO, render one pass.
 *
 * The render pass uses `samples: 1` and no depth attachment — the entire 3D
 * stack (depth resolve, MSAA depth, scene UBO updaters, etc.) is excluded.
 */

import type { EngineContext } from "../engine/engine.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { Renderable } from "../render/renderable.js";
import type { Scene2DContext, Scene2DContextInternal } from "./scene2d.js";
import type { Sprite2DLayer } from "../sprite/sprite-2d.js";
import { _tickSprite2DClips } from "../sprite/sprite-2d.js";
import { ensureSprite2DSceneUBO } from "../sprite/shared/sprite-2d-scene-ubo.js";

// Module-level pure comparator — defined once, no per-frame closure allocation.
function byOrder(a: Renderable, b: Renderable): number {
    return a.order - b.order;
}

async function buildLayer(engine: EngineContextInternal, layer: Sprite2DLayer, format: GPUTextureFormat, ctx: Scene2DContextInternal): Promise<void> {
    const mod = await import("../sprite/sprite-2d-renderable.js");
    // Shared per-scene Sprite2DSceneUBO (created lazily, registered once).
    const sceneUBO = ensureSprite2DSceneUBO(ctx);
    const built = mod.buildSprite2DRenderable(layer, {
        engine,
        format,
        msaaSamples: 1,
        hasDepth: false,
        sceneUBO,
    });
    ctx._renderables.push(built.renderable);
    ctx._disposables.push(() => {
        built.dispose();
    });
}

function resize(engine: EngineContext, _ctx: Scene2DContextInternal): void {
    const eng = engine as EngineContextInternal;
    const canvas = eng.canvas;
    const w = (canvas.clientWidth * devicePixelRatio) | 0;
    const h = (canvas.clientHeight * devicePixelRatio) | 0;
    if (w === 0 || h === 0) {
        // CSS layout not yet computed (or canvas is hidden) — keep prior size.
        return;
    }
    if (w !== eng.canvas.width || h !== eng.canvas.height) {
        canvas.width = w;
        canvas.height = h;
        eng.context.configure({ device: eng.device, format: eng.format, alphaMode: "opaque" });
    }
}

function renderFrame2D(engine: EngineContextInternal, scene: Scene2DContextInternal): void {
    for (const u of scene._updaters) {
        u.update(engine);
    }
    for (const r of scene._renderables) {
        if (r.updateUBOs) {
            r.updateUBOs();
        }
    }
    const swapView = engine.context.getCurrentTexture().createView();
    const encoder = engine.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
        colorAttachments: [
            {
                view: swapView,
                clearValue: scene.clearColor,
                loadOp: "clear",
                storeOp: "store",
            },
        ],
    });
    pass.setViewport(0, 0, engine.canvas.width, engine.canvas.height, 0, 1);
    let drawCalls = 0;
    let lastPipeline: GPURenderPipeline | null = null;
    let lastSceneBG: GPUBindGroup | null = null;
    // Sort by ascending order (layer.order via renderable.order). Refill the
    // reusable scratch in place so the per-frame path allocates nothing.
    const ordered = scene._sortedRenderables;
    ordered.length = 0;
    for (const r of scene._renderables) {
        ordered.push(r);
    }
    ordered.sort(byOrder);
    for (const r of ordered) {
        if (r._pipeline && r._pipeline !== lastPipeline) {
            pass.setPipeline(r._pipeline);
            lastPipeline = r._pipeline;
        }
        if (r._sceneBG && r._sceneBG !== lastSceneBG) {
            pass.setBindGroup(0, r._sceneBG);
            lastSceneBG = r._sceneBG;
        }
        drawCalls += r.draw(pass, engine);
    }
    pass.end();
    engine.device.queue.submit([encoder.finish()]);
    engine.drawCallCount = drawCalls;
}

export function startEngine2D(engine: EngineContext, scene: Scene2DContext): Promise<void> {
    const eng = engine as EngineContextInternal;
    const sc = scene as Scene2DContextInternal;
    return new Promise<void>((resolve) => {
        const boot = async () => {
            for (const layer of sc.layers) {
                await buildLayer(eng, layer, eng.format, sc);
            }
            // Per-frame: tick clips for every layer that has any.
            sc._beforeRender.unshift((dt) => {
                for (const layer of sc.layers) {
                    _tickSprite2DClips(layer, dt);
                }
            });

            let lastTime = 0;
            let firstFrame = true;
            sc._renderFn = (now: number) => {
                const delta = firstFrame ? 0 : sc.fixedDeltaMs > 0 ? sc.fixedDeltaMs : lastTime > 0 ? now - lastTime : 16.667;
                lastTime = now;
                resize(eng, sc);
                for (const cb of sc._beforeRender) {
                    cb(delta);
                }
                renderFrame2D(eng, sc);
                if (firstFrame) {
                    firstFrame = false;
                    resolve();
                }
                sc._animFrameId = requestAnimationFrame(sc._renderFn!);
            };
            sc._animFrameId = requestAnimationFrame(sc._renderFn);
        };
        void boot();
    });
}

/** Render a single frame synchronously. Caller must ensure builders have run. */
export async function renderSprite2DFrame(engine: EngineContext, scene: Scene2DContext): Promise<void> {
    const eng = engine as EngineContextInternal;
    const sc = scene as Scene2DContextInternal;
    resize(eng, sc);
    for (const cb of sc._beforeRender) {
        cb(0);
    }
    renderFrame2D(eng, sc);
    await eng.device.queue.onSubmittedWorkDone();
}
