// Standalone worker-player entry (`@babylonjs/lottie-player/standalone`) for hosts that deliver
// JavaScript as prebuilt static resources without a webpack/Vite step.
//
// Unlike the bundler entries, this client does not auto-detect a worker variant: pass `workerUrl`
// pointing at either prebuilt, self-contained CLASSIC worker (`dist/workers/full.worker.js` or
// `dist/workers/shapes.worker.js`), hosted same-origin. It is loaded as a CSP-friendly `blob:`
// worker (see BlobWorkerWrapper).
//
// This module deliberately does NOT import the `import.meta.url` default-worker factory, so a
// non-module / non-bundler build never trips over `import.meta`, and standalone hosts pay zero bytes
// for the bundler-detection path (and bundler clients pay nothing for this entry).
//
//   import { createLottieWorkerPlayer, playWorkerAnimationAsync } from "@babylonjs/lottie-player/standalone";
//   const player = createLottieWorkerPlayer({ workerUrl: "/static/lottie-player.full.worker.js" });
//   await playWorkerAnimationAsync(player, { container, animationSource: inlineJson });

import { BlobWorkerWrapper } from "./client/blob-worker.js";
import { createWorkerPlayer, type LottieWorkerPlayer } from "./client/runtime.js";

/** Options for the explicit-worker-source standalone player. */
export interface WorkerPlayerOptions {
    /** Same-origin URL of a self-contained classic worker. */
    workerUrl: string | URL;
}

/** Create a worker-backed Lottie player from an explicit worker URL. */
export function createLottieWorkerPlayer(options: WorkerPlayerOptions): LottieWorkerPlayer {
    const workerUrl = options.workerUrl;
    return createWorkerPlayer(() => new BlobWorkerWrapper(workerUrl).getWorker());
}

export { playWorkerAnimationAsync, disposeWorkerPlayer } from "./client/runtime.js";
export type { LottieWorkerPlayer, LottieWorkerInput } from "./client/runtime.js";
export type { LottieFile } from "./animation/lottie-raw.js";
export type { LottieVariables } from "./animation/parse.js";
