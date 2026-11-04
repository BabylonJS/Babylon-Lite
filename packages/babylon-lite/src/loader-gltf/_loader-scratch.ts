/** @internal Lazy-init mat4 scratch buffers for the glTF loader. Each getter
 *  returns a single module-level instance that is reused across all calls
 *  (and across concurrent loadGltf calls).
 *
 *  Safe because every glTF parse path that touches scratch is fully synchronous
 *  between scratch reads/writes — the only `await`s in the loader are around
 *  network fetch and image decode, neither of which touches matrix scratch.
 *  JS single-threadedness guarantees no other parse can interleave through
 *  a scratch use-site mid-computation.
 *
 *  Replaces the prior `LoaderScratch` interface that was created per-call by
 *  `createLoaderScratch(engine)` and threaded as an explicit `scratch:` param
 *  through every parser/animation/instancing function. Removing the threading
 *  shaves ~200-300 bytes per scene by eliminating the parameter signatures,
 *  the per-load factory call, and the engine.matrixPolicy capture.
 *
 *  Backing precision tracks the process-global allocator in
 *  `_matrix-allocator.ts` — F32 by default, F64 after an HPM engine is
 *  constructed (see `docs/lite/architecture/36-high-precision-matrix.md`). */

import type { Mat4 } from "../math/types.js";
import { allocateMat4 } from "../math/_matrix-allocator.js";

let _tmpLocal: Mat4 | null = null;
let _tmpAnim: Mat4 | null = null;
let _tmpInstance: Mat4 | null = null;

/** Scratch for non-recursive local TRS composition in `computeNodeWorldMatrix`.
 *  Safe to reuse across non-recursive sibling calls; recursive `world`
 *  matrices are still allocated per-call inside the parser. */
export function getLoaderTmpLocal(): Mat4 {
    return (_tmpLocal ??= allocateMat4());
}

/** Scratch for per-bone matrix multiplication inside `computeBoneTextureData`. */
export function getLoaderTmpAnim(): Mat4 {
    return (_tmpAnim ??= allocateMat4());
}

/** Scratch for per-instance world composition inside the GPU-instancing feature. */
export function getLoaderTmpInstance(): Mat4 {
    return (_tmpInstance ??= allocateMat4());
}
