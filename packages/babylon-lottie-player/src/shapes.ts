// Public shapes-only entry. Bundlers discover a worker whose graph excludes text and image
// renderers, making this the minimal worker-backed option for vector-only animations.
export { createShapeWorkerPlayer } from "./client/shapes-client.js";
export { playWorkerAnimationAsync, disposeWorkerPlayer } from "./client/runtime.js";
export type { LottieWorkerPlayer, LottieWorkerInput } from "./client/runtime.js";
export type { LottieFile } from "./animation/lottie-raw.js";
export type { LottieVariables } from "./animation/parse.js";
