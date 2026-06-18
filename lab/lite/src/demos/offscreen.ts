/**
 * Demo — Offscreen.
 *
 * Side-by-side proof that Babylon Lite renders identically whether the engine
 * runs on the main thread or inside a Web Worker via `OffscreenCanvas`:
 *
 *   - LEFT  (#renderCanvas)       — Lite engine created directly on a DOM canvas
 *                                   on the MAIN THREAD.
 *   - RIGHT (#workerRenderCanvas) — the canvas is `transferControlToOffscreen()`-ed
 *                                   and handed to a WORKER that runs its own Lite
 *                                   engine.
 *
 * The "block main thread" button runs a heavy synchronous loop on the main
 * thread: the left canvas stutters/freezes while the worker-driven right canvas
 * keeps spinning at full speed — the whole reason offscreen rendering exists.
 */
import { BRDF_ASSET, startOffscreenScene } from "./offscreen-scene";
import { installFetchProgress } from "./loading-progress.js";

const DPR = (): number => globalThis.devicePixelRatio || 1;

const BRDF_URL = BRDF_ASSET;

function deviceSize(canvas: HTMLCanvasElement): { w: number; h: number } {
    const dpr = DPR();
    return {
        w: Math.max(1, Math.round(canvas.clientWidth * dpr)),
        h: Math.max(1, Math.round(canvas.clientHeight * dpr)),
    };
}

async function main(): Promise<void> {
    const leftCanvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const rightCanvas = document.getElementById("workerRenderCanvas") as HTMLCanvasElement;
    const workerStatus = document.getElementById("workerStatus");
    const slowButton = document.getElementById("slowButton") as HTMLButtonElement | null;

    // The main-thread (left) engine performs the real asset downloads (glTF +
    // environment); the worker mostly re-uses the warm HTTP cache, now that the
    // model is a loose-file glTF whose small per-texture files are individually
    // cacheable. Report that download.
    const progress = installFetchProgress(leftCanvas, { estimatedBytes: 49_000_000 });

    let leftReady = false;
    let rightReady = false;
    const markReadyIfDone = (): void => {
        if (leftReady && rightReady) {
            leftCanvas.dataset.ready = "true";
        }
    };

    // ── LEFT: main-thread engine, rendered directly on the DOM canvas. ──
    void startOffscreenScene(leftCanvas, BRDF_URL)
        .then(() => {
            progress.done();
            leftReady = true;
            markReadyIfDone();
        })
        .catch((err: unknown) => {
            progress.done();
            leftCanvas.dataset.error = String(err);
        });

    // ── RIGHT: OffscreenCanvas handed to a worker. ──
    const supportsOffscreen = typeof rightCanvas.transferControlToOffscreen === "function" && typeof Worker !== "undefined";

    if (supportsOffscreen) {
        const worker = new Worker(new URL("./offscreen-worker.ts", import.meta.url), { type: "module" });
        const offscreen = rightCanvas.transferControlToOffscreen();
        const initSize = deviceSize(rightCanvas);

        worker.addEventListener("message", (ev: MessageEvent<{ type: string; message?: string }>) => {
            if (ev.data.type === "ready") {
                rightReady = true;
                markReadyIfDone();
            } else if (ev.data.type === "error") {
                if (workerStatus) {
                    workerStatus.textContent = "Worker error";
                }
                rightReady = true;
                markReadyIfDone();
            }
        });
        worker.addEventListener("error", () => {
            if (workerStatus) {
                workerStatus.textContent = "Worker error";
            }
            rightReady = true;
            markReadyIfDone();
        });

        worker.postMessage({ type: "init", canvas: offscreen, width: initSize.w, height: initSize.h, brdfUrl: BRDF_URL }, [offscreen]);

        // Keep the worker's backing store in sync with the canvas layout (device px).
        let lastW = initSize.w;
        let lastH = initSize.h;
        const pushSize = (): void => {
            const { w, h } = deviceSize(rightCanvas);
            if (w === lastW && h === lastH) {
                return;
            }
            lastW = w;
            lastH = h;
            worker.postMessage({ type: "resize", width: w, height: h });
        };
        new ResizeObserver(pushSize).observe(rightCanvas);
        // ResizeObserver won't fire on a pure devicePixelRatio change (browser zoom /
        // monitor move), so watch DPR explicitly and re-push when it changes.
        const watchDpr = (): void => {
            const mq = matchMedia(`(resolution: ${DPR()}dppx)`);
            mq.addEventListener("change", () => {
                pushSize();
                watchDpr();
            });
        };
        watchDpr();
    } else {
        // No OffscreenCanvas support — fall back to a second main-thread engine so the
        // demo still renders, and label it honestly.
        if (workerStatus) {
            workerStatus.textContent = "OffscreenCanvas unsupported — main thread fallback";
        }
        void startOffscreenScene(rightCanvas, BRDF_URL)
            .then(() => {
                rightReady = true;
                markReadyIfDone();
            })
            .catch(() => {
                rightReady = true;
                markReadyIfDone();
            });
    }

    // ── Heavy main-thread work toggle. ──
    if (slowButton) {
        let blocking = false;
        let sink = 0;
        const CHUNK_MS = 200;
        const busyChunk = (): void => {
            const end = performance.now() + CHUNK_MS;
            let x = sink;
            while (performance.now() < end) {
                for (let i = 0; i < 20000; i++) {
                    x += Math.sqrt(i * 1.000001) * Math.sin(x + i);
                }
            }
            sink = x;
            if (blocking) {
                setTimeout(busyChunk, 0);
            }
        };
        slowButton.addEventListener("click", () => {
            blocking = !blocking;
            slowButton.dataset.active = blocking ? "true" : "false";
            slowButton.textContent = blocking ? "⏱️ Blocking main thread… (click to stop)" : "🐌 Block the main thread";
            if (blocking) {
                setTimeout(busyChunk, 0);
            }
        });
    }
}

void main().catch((err) => console.error(err));
