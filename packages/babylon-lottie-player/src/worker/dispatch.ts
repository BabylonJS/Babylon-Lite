// In-worker message dispatcher — the body of the Lottie render worker, shared by both variants.
//
// `runLottieWorker(createPlayer)` installs the worker's `onmessage` handler and holds the per-worker
// state (the loaded document and the live controller). The full and shapes-only worker entries call
// it with their respective player factory; because the factory is a PARAMETER, this module never
// imports a renderer itself, so the shapes worker's graph stays free of the text + image renderers.
//
// Everything here is worker-safe: it touches only the OffscreenCanvas, `fetch`, and the engine —
// never the DOM. (The text renderer, the one renderer that rasterizes glyphs, was moved onto an
// `OffscreenCanvas` for exactly this reason.)

import type { LottieFile } from "../animation/lottie-raw.js";
import type { WorkerInbound, WorkerOutbound } from "./protocol.js";
import { createController, resizeController, startController, type LottieController, type PlayerFactory } from "./controller.js";

type PrepareFile = (file: LottieFile, sourceUrl: string) => void;

/**
 * Install the worker's message handler. Call once at the top of a worker entry module.
 * @param createPlayer - Factory selecting the renderer set (full vs shapes-only).
 * @param prepareFile - Optional full-player preparation for URL-loaded documents.
 */
export function runLottieWorker(createPlayer: PlayerFactory, prepareFile?: PrepareFile): void {
    let file: LottieFile | null = null;
    let controller: LottieController | null = null;

    // Single-argument postMessage (no transferables worker → main). Typed loosely because a TS
    // project configured with the DOM lib types the global `postMessage` as the window overload.
    const post = (message: WorkerOutbound): void => {
        (postMessage as (message: unknown) => void)(message);
    };
    const fail = (): void => post({ type: "error" });

    self.onmessage = async (event: MessageEvent): Promise<void> => {
        const message = event.data as WorkerInbound | undefined;
        if (!message) {
            return;
        }

        switch (message.type) {
            case "load": {
                try {
                    const response = await fetch(message.url);
                    if (!response.ok) {
                        fail();
                        return;
                    }
                    file = (await response.json()) as LottieFile;
                    prepareFile?.(file, response.url);
                    post({ type: "size", width: file.w, height: file.h });
                } catch {
                    fail();
                }
                break;
            }
            case "start": {
                const document = message.file ?? file;
                if (!document) {
                    fail();
                    return;
                }
                file = document;
                try {
                    controller = createController(
                        message.canvas,
                        document,
                        createPlayer,
                        message.displayWidth,
                        message.displayHeight,
                        message.devicePixelRatio,
                        message.loop,
                        () => post({ type: "firstRender" }),
                        message.variables,
                        fail
                    );
                    startController(controller);
                } catch {
                    fail();
                }
                break;
            }
            case "resize": {
                if (controller) {
                    resizeController(controller, message.displayWidth, message.displayHeight, message.devicePixelRatio);
                }
                break;
            }
        }
    };
}
