// Perf adapter for the STENCIL (vector, WebGL2) player. Exposes a common `window.__bench.start`
// the shared bench page calls. Stamps canvas.dataset.initMs (player construction cost),
// dataset.ttfMs (time to first painted frame) and dataset.ready. Drives its own 60fps-uncapped
// RAF loop; the driver's RAF wrap times each callback (CPU per frame) and counts GL draw calls.
import type { LottieFile } from "../../src/animation/lottie-raw.js";
import { createLottiePlayer } from "../../src/player/full-player.js";
import { createVectorEngine, renderLottieFrame, isPlayerReady } from "../../src/player/player-core.js";

async function start(canvas: HTMLCanvasElement, json: LottieFile): Promise<void> {
    const t0 = performance.now();
    canvas.width = json.w;
    canvas.height = json.h;
    const engine = createVectorEngine(canvas);
    const player = createLottiePlayer(engine, json);
    // Init = synchronous construction cost (engine + player objects). Shader compile is async and
    // shows up in TTF below.
    canvas.dataset.initMs = String(performance.now() - t0);

    const ip = json.ip ?? 0;
    const op = json.op ?? 60;
    const fr = json.fr ?? 30;
    const span = Math.max(1, op - ip);
    const loopStart = performance.now();
    let painted = false;

    function loop(): void {
        const t = (performance.now() - loopStart) / 1000;
        const frame = ip + ((t * fr) % span);
        renderLottieFrame(player, frame);
        if (!painted && isPlayerReady(player)) {
            painted = true;
            canvas.dataset.ttfMs = String(performance.now() - t0);
            canvas.dataset.ready = "true";
        }
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

(globalThis as unknown as { __bench: { start: typeof start } }).__bench = { start };
