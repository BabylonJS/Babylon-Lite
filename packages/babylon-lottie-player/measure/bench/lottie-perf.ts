// Perf adapter for lottie-react (^2.3.1). lottie-react is a thin React wrapper over lottie-web, so for
// a clean, React-free time-to-first-frame we drive lottie-web DIRECTLY (exactly what lottie-react
// calls under the hood) with the CANVAS renderer — that gives a <canvas> the harness can read plus a
// DOMLoaded event for the TTF stamp. SIZE is measured against lottie-react (the actual product dep);
// the runtime engine is lottie-web either way.
//
// lottie-web renders on the CPU (Canvas2D), so it has NO WebGL draw boundary — the driver's draw-call
// / RAF-CPU / FPS metrics don't apply and are reported N/A (see perf.mjs). We stamp only ready + ttf;
// the driver reads TTF + memory. Unlike the atlas players, lottie-web supports the FULL Lottie format
// (morphs, masks, images), so it is NEVER capability-gated.
import lottie from "lottie-web";

async function start(pageCanvas: HTMLCanvasElement, json: { w: number; h: number } & Record<string, unknown>): Promise<void> {
    const t0 = performance.now();

    // Give lottie-web its own container; remove the page placeholder so document.querySelector("canvas")
    // resolves to the canvas lottie-web creates (the driver reads ready/ttf + dims from it).
    pageCanvas.remove();
    const container: HTMLDivElement = document.createElement("div");
    container.style.width = `${json.w}px`;
    container.style.height = `${json.h}px`;
    document.body.appendChild(container);

    const anim = lottie.loadAnimation({
        container,
        renderer: "canvas",
        loop: true,
        autoplay: true,
        animationData: json,
    });

    anim.addEventListener("DOMLoaded", () => {
        const c = container.querySelector("canvas");
        if (c) {
            c.dataset.ttfMs = String(performance.now() - t0);
            c.dataset.ready = "true";
        }
    });
}

(globalThis as unknown as { __bench: { start: typeof start } }).__bench = { start };
