// Full worker-player client (main thread, `.` entry) — constructs the FULL render worker (fill +
// text + image, activated from the document's layer kinds) and returns a worker-backed player. Worker creation
// uses the bundler-detected default (see default-worker.ts). Non-bundler hosts use the
// `./standalone` entry instead.

import { createWorkerPlayer, type LottieWorkerPlayer } from "./runtime.js";
import { createDefaultFullWorker } from "./default-worker.js";

/** Create a worker-backed player that can render any supported Lottie animation (shapes, text,
 *  images, gradients, strokes, masks, morphs). Drive it with {@link playWorkerAnimationAsync} and
 *  release it with {@link disposeWorkerPlayer}. */
export function createLottieWorkerPlayer(): LottieWorkerPlayer {
    return createWorkerPlayer(createDefaultFullWorker);
}
