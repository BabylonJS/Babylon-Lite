// MEASUREMENT-ONLY entry for the stencil worker's MAIN-THREAD client (full variant). Re-exports the
// public worker-player API a consumer ships on the main thread in the worker scenario:
// createLottieWorkerPlayer + the runtime functions. The worker chunk itself is externalized at build
// time (see size-lib's externalizeWorker plugin), so this measures ONLY the main-thread bytes —
// the bytes that sit on the critical path before the worker is even spawned. Not shipped.
export { createLottieWorkerPlayer } from "../src/client/full-client.js";
export { playWorkerAnimationAsync, disposeWorkerPlayer } from "../src/client/runtime.js";
