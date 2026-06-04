// Scene 201 — High-Precision Matrix jitter, HPM **ON**, floating-origin **ON**.
//
// The "good case". Same geometry as scene 200 but constructs the engine
// with `useHighPrecisionMatrix: true` and the scene with
// `useFloatingOrigin: true`. World-matrix translation columns are
// stored as Float64Array; at upload time the floating-origin offset
// (camera world position) is subtracted in F64 before the F32 store.
// View matrix translation is mathematically zero. The result is
// pixel-precise rendering at world coords ~1e6 where scene 200 jitters.

import { runHpmJitterScene } from "../_shared/hpm-jitter-scene";

runHpmJitterScene({ useHighPrecisionMatrix: true, useFloatingOrigin: true }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
