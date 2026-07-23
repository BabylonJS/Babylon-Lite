import { createSplatSortScratch, sortSplatsBackToFront, type SplatSortScratch } from "./splat-sort-core.js";
/** Splat sort worker.
 *
 *  Vite import: `import SortWorker from './splat-sort-worker.ts?worker&inline'`.
 *  The `?worker&inline` query keeps the bundled worker JS embedded as a base-64
 *  blob in the splat scene chunk — it adds zero bytes to any other scene
 *  because the whole `loader-splat/` module is dynamic-imported.
 *
 *  Protocol
 *  --------
 *  Init (once):  `{ p: Float32Array, n: number }`
 *                — buffer is transferred and retained on the worker side.
 *                — positions are in mesh-LOCAL space (stride 3, xyz per splat).
 *  Sort  (N×):   `{ m: Float32Array(16), f: Float32Array(3), c: Float32Array(3), o: Uint32Array }`
 *                — `o` is a transferable order buffer owned by the main thread's
 *                  pool (`mesh._orderPool`); the worker fills it with splat
 *                  indices in back-to-front order and transfers it back as
 *                  `{ o }`. The pool holds two buffers, so a second sort job can
 *                  be in flight while the previous result is still in transit —
 *                  the worker never idles on the round-trip during camera motion.
 *
 *  The sort itself is the adaptive-precision counting sort in
 *  `splat-sort-core.ts` (O(n), density-weighted key allocation) — see that
 *  module for the algorithm and the depth recipe
 *  `cameraForward · (world · localPos - cameraPos)`. */

let positions: Float32Array | null = null;
let vertexCount = 0;
let scratch: SplatSortScratch | null = null;

self.onmessage = (e: MessageEvent) => {
    const data = e.data as {
        p?: Float32Array;
        n?: number;
        m?: Float32Array;
        f?: Float32Array;
        c?: Float32Array;
        o?: Uint32Array;
    };

    if (data.p) {
        positions = data.p;
        vertexCount = data.n ?? 0;
        scratch = createSplatSortScratch(vertexCount);
        return;
    }

    if (!positions || !scratch || !data.m || !data.f || !data.c || !data.o) {
        return;
    }

    const order = data.o;
    sortSplatsBackToFront(positions, vertexCount, data.m, data.f, data.c, order, scratch);

    (self as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage({ o: order }, [order.buffer]);
};
