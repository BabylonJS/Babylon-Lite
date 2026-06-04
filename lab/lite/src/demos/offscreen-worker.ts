/**
 * Demo — Offscreen, worker entry.
 *
 * Runs a full Babylon Lite engine inside a Web Worker, rendering into an
 * `OffscreenCanvas` that the main thread transferred to us. Because the engine
 * lives off the main thread, the right-hand canvas keeps animating at full speed
 * even while the page's main thread is blocked by heavy synchronous work.
 *
 * Protocol (main → worker):
 *   { type: "init", canvas: OffscreenCanvas, width, height, brdfUrl }  — start rendering
 *   { type: "resize", width, height }                         — backing-store size (device px)
 * Protocol (worker → main):
 *   { type: "ready" }            — first frame rendered
 *   { type: "error", message }   — scene failed to start
 */
import { setEngineSize, type EngineContext } from "babylon-lite";
import { startOffscreenScene } from "./offscreen-scene";

// In a module worker the global scope behaves like a `Worker` for messaging.
const ctx = self as unknown as Worker;

let engine: EngineContext | null = null;
let pendingSize: { w: number; h: number } | null = null;

interface InitMessage {
    type: "init";
    canvas: OffscreenCanvas;
    width: number;
    height: number;
    brdfUrl: string;
}
interface ResizeMessage {
    type: "resize";
    width: number;
    height: number;
}
type IncomingMessage = InitMessage | ResizeMessage;

ctx.addEventListener("message", (ev: MessageEvent<IncomingMessage>) => {
    const msg = ev.data;
    if (msg.type === "init") {
        const canvas = msg.canvas;
        canvas.width = msg.width;
        canvas.height = msg.height;
        void startOffscreenScene(canvas, msg.brdfUrl)
            .then((eng) => {
                engine = eng;
                // Apply any resize that arrived while we were still initializing.
                if (pendingSize) {
                    setEngineSize(eng, pendingSize.w, pendingSize.h);
                    pendingSize = null;
                }
                ctx.postMessage({ type: "ready" });
            })
            .catch((err: unknown) => {
                ctx.postMessage({ type: "error", message: String(err) });
            });
    } else if (msg.type === "resize") {
        if (engine) {
            setEngineSize(engine, msg.width, msg.height);
        } else {
            pendingSize = { w: msg.width, h: msg.height };
        }
    }
});
