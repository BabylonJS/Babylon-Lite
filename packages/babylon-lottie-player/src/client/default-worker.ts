// Bundler-detected default worker factories — the ONLY module that references `import.meta.url`.
//
// Writing `new Worker(new URL("../worker/x.worker.js", import.meta.url))` is the literal webpack/Vite detect
// to emit the worker as its own (classic) chunk and rewrite the URL. We import `BlobWorkerWrapper`
// **as `Worker`**, so that same literal constructs the blob wrapper at runtime — i.e. the bundler
// emits + locates the worker, and it is transparently blob-wrapped (required by M365's CSP). This is
// the "alias the blob helper to Worker" trick, built into the package so bundler consumers configure nothing.
//
// It lives in its own module so the `./standalone` (non-bundler) entry can exclude it entirely — some
// non-ESM / non-bundler outputs choke on `import.meta`, and standalone hosts inject `workerUrl` instead.

import { BlobWorkerWrapper as Worker } from "./blob-worker.js";

/** The default FULL worker (fill + text + image), bundler-detected + blob-wrapped. */
export function createDefaultFullWorker(): globalThis.Worker {
    return new Worker(new URL("../worker/full.worker.js", import.meta.url)).getWorker();
}

/** The default SHAPES-only worker, bundler-detected + blob-wrapped. */
export function createDefaultShapesWorker(): globalThis.Worker {
    return new Worker(new URL("../worker/shapes.worker.js", import.meta.url)).getWorker();
}
