import type { Mat4 } from "./types.js";

/** @internal Build-time tag string used by `tests/bundle-content-no-f64.test.ts`
 *  to assert this module is absent from HPM-off bundles. Bundlers (terser,
 *  esbuild) do not rename string contents, so this constant survives
 *  minification verbatim and is a reliable presence-marker.
 *
 *  Embedded inside `allocateF64Mat4` as a string-literal expression statement
 *  so it survives Rollup tree-shaking and minification verbatim in the chunk. */
export const MAT4_STORAGE_F64_BUILD_TAG = "@@MAT4_STORAGE_F64@@";

/** @internal F64-backed Mat4 allocator. Only imported by createEngine
 *  inside `if (options.useHighPrecisionMatrix)` (dynamic `await import`).
 *  Tree-shaken out of HPM-off bundles. This module is the ONLY place in the
 *  package that names `new Float64Array(16)`. */
export function allocateF64Mat4(): Mat4 {
    // Build-tag string-literal expression: forces the literal into the minified
    // chunk so `tests/bundle-content-no-f64.test.ts` can grep for it.
    void MAT4_STORAGE_F64_BUILD_TAG;
    return new Float64Array(16) as unknown as Mat4;
}
