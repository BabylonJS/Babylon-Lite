// Perf adapter for the SPRITES (raster atlas, WebGL2) player. Same `window.__bench.start` protocol
// as the stencil adapter so the bench page and Playwright driver are player-agnostic. Imports the
// sprites player's MAIN-THREAD renderer core from the VENDORED sprite source (measure/vendor/sprite).
//
// IMPORTANT (matches the original lottie-bench runtime adapter):
//   • We DRIVE THE RENDER MANUALLY each rAF (setViewport + UpdateNode + renderFrame) rather than
//     calling playAnimation — createAnimationControllerAsync intentionally does NOT start the
//     player's own (30fps-throttled) loop, and manual drive is what reliably paints + lets the
//     driver's GL draw-call counter see the per-frame draw.
//   • We PIN a 2048×2048 atlas. The player's default auto-atlas is 8192² (~256 MB GPU texture),
//     which STALLS the headed-automation compositor and paints NOTHING (the blank-canvas symptom).
//     Per-frame work is atlas-size independent; only the one-time upload + GPU memory scale with it.
//   • dpr is pinned to 1 (the default auto-dpr is 2–4× supersampling) so output resolution matches
//     the stencil player for a fair perf comparison.
import { setViewport } from "babylon-lite-gl";
import { createAnimationControllerAsync } from "../vendor/sprite/rendering/animationController.js";
import { ResetNode, UpdateNode } from "../vendor/sprite/nodes/node.js";
import { renderFrame } from "../vendor/sprite/rendering/renderingManager.js";
import type { RawLottieAnimation } from "../vendor/sprite/parsing/rawTypes.js";

async function start(canvas: HTMLCanvasElement, json: RawLottieAnimation & { w: number; h: number }): Promise<void> {
    const t0 = performance.now();
    const controller = await createAnimationControllerAsync(canvas, json, 1, 1, new Map<string, string>(), {
        loopAnimation: true,
        devicePixelRatio: 1,
        spriteAtlasWidth: 2048,
        spriteAtlasHeight: 2048,
    });
    // Init = async construction cost (feature load + parse + ATLAS BUILD + sizing), after the await.
    canvas.dataset.initMs = String(performance.now() - t0);

    const anim = controller.animation;
    if (!anim) {
        canvas.dataset.ready = "true";
        return;
    }
    const fr = anim.frameRate;
    const span = Math.max(1, anim.endFrame - anim.startFrame);
    const loopStart = performance.now();
    let painted = false;
    let lastFrame = -1;

    const drawAt = (f: number): void => {
        setViewport(controller.engine);
        for (let i = 0; i < anim.nodes.length; i++) {
            UpdateNode(anim.nodes[i], f);
        }
        renderFrame(controller.renderingManager, controller.worldMatrix, controller.projectionMatrix);
    };

    function loop(): void {
        const t = (performance.now() - loopStart) / 1000;
        const frame = anim.startFrame + ((t * fr) % span);
        // On loop wrap (frame went backwards), reset per-node sampler state so cached tracks re-evaluate.
        if (frame < lastFrame) {
            for (let i = 0; i < anim.nodes.length; i++) {
                ResetNode(anim.nodes[i]);
            }
        }
        lastFrame = frame;
        drawAt(frame);
        if (!painted) {
            painted = true;
            canvas.dataset.ttfMs = String(performance.now() - t0);
            canvas.dataset.ready = "true";
        }
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

(globalThis as unknown as { __bench: { start: typeof start } }).__bench = { start };
