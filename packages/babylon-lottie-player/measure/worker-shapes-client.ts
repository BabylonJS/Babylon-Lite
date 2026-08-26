// MEASUREMENT-ONLY entry for the SHAPES worker's main-thread client (createShapeWorkerPlayer +
// runtime). The shapes-variant counterpart of worker-full-client.ts; the worker chunk is
// externalized so this measures only main-thread bytes. Not shipped.
export { createShapeWorkerPlayer } from "../src/client/shapes-client.js";
export { playWorkerAnimationAsync, disposeWorkerPlayer } from "../src/client/runtime.js";
