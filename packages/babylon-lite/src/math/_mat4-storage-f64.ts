import type { Mat4 } from "./types.js";

/** @internal Build-time tag string used by `tests/bundle-content-no-f64.test.ts`
 *  to assert this module is absent from HPM-off bundles. Bundlers (terser,
 *  esbuild) do not rename string contents, so this constant survives
 *  minification verbatim and is a reliable presence-marker.
 *
 *  Embedded as a property assignment on the exported function below — terser
 *  treats property assignments on exported bindings as observable side effects
 *  and preserves them. A `void` expression-statement (e.g. `void TAG;`) does
 *  NOT survive minification because the result is unused and the read can be
 *  proven side-effect-free. */
export const MAT4_STORAGE_F64_BUILD_TAG = "@@MAT4_STORAGE_F64@@";

/** @internal F64-backed Mat4 allocator. Only imported by createEngine
 *  inside `if (options.useHighPrecisionMatrix)` (dynamic `await import`).
 *  Tree-shaken out of HPM-off bundles. This module is the ONLY place in the
 *  package that names `new Float64Array(16)`. */
export function allocateF64Mat4(): Mat4 {
    return new Float64Array(16) as unknown as Mat4;
}

// Pin the build tag string into the emitted chunk so the bundle-content
// assertion (tests/bundle-content-no-f64.test.ts) can grep for it. Property
// assignment on an exported function is a side effect the minifier preserves.
(allocateF64Mat4 as unknown as Record<string, true>)[MAT4_STORAGE_F64_BUILD_TAG] = true;
