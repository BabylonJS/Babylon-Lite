// Shapes-only worker-player client (main thread). Constructs the minimal render worker — the fill
// renderer alone (shapes, solids, gradients, strokes, masks, morphs), no text or image — for
// splashscreens and other vector-only animations. The worker chunk it spawns is the off-thread
// counterpart of the `@babylonjs/lottie-player/shapes` entry, and its module graph never reaches the
// text/image renderers, so it stays minimal.

import { createWorkerPlayer, type LottieWorkerPlayer } from "./runtime.js";
import { createDefaultShapesWorker } from "./default-worker.js";

/** Create a worker-backed shapes-only player for vector Lottie animations (e.g. a splashscreen).
 *  Renders shape + solid layers; text and image layers are ignored. Drive it with
 *  {@link playWorkerAnimationAsync} and release it with {@link disposeWorkerPlayer}. */
export function createShapeWorkerPlayer(): LottieWorkerPlayer {
    return createWorkerPlayer(createDefaultShapesWorker);
}
