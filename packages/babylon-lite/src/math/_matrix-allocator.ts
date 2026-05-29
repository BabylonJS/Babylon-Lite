import type { Mat4 } from "./types.js";

/** @internal Lazy-init matrix allocator (GUIDANCE pillar 4 — module-level state
 *  is permitted in lazy-init form because it allocates nothing at import time).
 *
 *  The default allocator returns a fresh `Float32Array(16)`. When the first
 *  HPM-enabled engine is constructed, `createEngine` dynamic-imports
 *  `_mat4-storage-f64.ts` and calls `_setHpmAllocator(allocateF64Mat4)`,
 *  swapping in the F64 backing.
 *
 *  **Constraint:** the allocator is process-global. Pages that mix
 *  HPM and non-HPM engines are unsupported — the second engine silently
 *  inherits the first engine's storage precision. See GUIDANCE pillar 4b″
 *  for the rationale (single precision per page).
 *
 *  This pattern replaces the per-engine `_matrixPolicy` field that previously
 *  threaded the allocator through every entity factory and loader. Removing
 *  the field shaves ~300-500 bytes per scene (no more closure captures,
 *  no `LoaderScratch` struct, no `engine.` prefix at every allocation site). */
let _allocate: () => Mat4 = (): Mat4 => new Float32Array(16) as unknown as Mat4;

/** Allocate a fresh zero-initialized 16-element `Mat4`. Returns an F32 array by
 *  default, or F64 if any engine on the page was created with
 *  `useHighPrecisionMatrix: true`. */
export function allocateMat4(): Mat4 {
    return _allocate();
}

/** @internal Install the HPM (F64) allocator. Called once by `createEngine`
 *  when `useHighPrecisionMatrix: true`. Subsequent calls overwrite. */
export function _setHpmAllocator(allocate: () => Mat4): void {
    _allocate = allocate;
}

/** @internal Reset the allocator to the F32 default. Test-only — production
 *  code never reverts precision. */
export function _resetMatrixAllocatorForTests(): void {
    _allocate = (): Mat4 => new Float32Array(16) as unknown as Mat4;
}
