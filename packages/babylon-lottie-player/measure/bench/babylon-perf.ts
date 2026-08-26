// Perf adapter for the CURRENT PRODUCTION Babylon.js Lottie player (`@babylonjs/lottie-player`).
// Exposes the SAME `window.__bench.start(canvas, json)` protocol as the sprite/stencil adapters so
// the bench page and Playwright driver stay player-agnostic. It uses the public main-thread
// `LocalPlayer`; the driver instruments `requestAnimationFrame` + WebGL2 draw calls GLOBALLY, so it
// observes the player's own canvas, RAF render loop, and draws even though `LocalPlayer` owns them.
//
// `LocalPlayer.playAnimationAsync` takes a CONTAINER div (it creates + appends its own canvas), so we
// remove the page's placeholder canvas and let the player's canvas become the document's only canvas
// — the driver reads `dataset.ready`/`initMs`/`ttfMs` + dims from `document.querySelector("canvas")`.
// We pin dpr = 1 and a 2048² atlas for parity with the sprite adapter (and to avoid the huge
// auto-atlas that stalls the headed compositor). `onFirstRender` gives the time-to-first-frame stamp.
import { LocalPlayer } from "@babylonjs/lottie-player";
import type { RawLottieAnimation } from "@babylonjs/lottie-player";

async function start(pageCanvas: HTMLCanvasElement, json: RawLottieAnimation & { w: number; h: number }): Promise<void> {
    const t0 = performance.now();

    // LocalPlayer injects its own canvas into a container element; the page's placeholder canvas
    // can't be that container, so remove it — the player's canvas becomes the document's only canvas.
    pageCanvas.remove();
    const container: HTMLDivElement = document.createElement("div");
    container.style.width = `${json.w}px`;
    container.style.height = `${json.h}px`;
    document.body.appendChild(container);

    const player = new LocalPlayer();
    await player.playAnimationAsync({
        container,
        animationSource: json,
        variables: null,
        // dpr 1 + a pinned 2048² atlas: parity with the sprite adapter and avoids the huge auto-atlas
        // that stalls headed automation. Per-frame work is atlas-size independent.
        configuration: { loopAnimation: true, devicePixelRatio: 1, spriteAtlasWidth: 2048, spriteAtlasHeight: 2048 },
        onFirstRender: () => {
            const c = container.querySelector("canvas");
            if (c) {
                c.dataset.ttfMs = String(performance.now() - t0);
                c.dataset.ready = "true";
            }
        },
    });

    // Init = async construction cost (parse + atlas build + sizing), stamped after the await and
    // before the first RAF paints (which fires onFirstRender above and stamps ttf + ready).
    const c = container.querySelector("canvas");
    if (c) {
        c.dataset.initMs = String(performance.now() - t0);
    }
}

(globalThis as unknown as { __bench: { start: typeof start } }).__bench = { start };
