// Public full-player entry. Rendering runs on an OffscreenCanvas inside a Web Worker; bundlers
// discover and emit the full worker through client/default-worker.ts.
export { createLottieWorkerPlayer } from "./client/full-client.js";
export { playWorkerAnimationAsync, disposeWorkerPlayer } from "./client/runtime.js";
export type { LottieWorkerPlayer, LottieWorkerInput } from "./client/runtime.js";
export type { LottieFile } from "./animation/lottie-raw.js";
export type { LottieVariables } from "./animation/parse.js";
