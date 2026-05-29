// Scene 201 — High-Precision Matrix jitter, HPM **ON** (F64 storage).
//
// Identical geometry to scene 200 but constructs the engine with
// `useHighPrecisionMatrix: true`. The CPU-side view-projection chain is
// stored as Float64Array; only the final F32 GPU upload performs the
// downcast (see `packMat4IntoF32`). At world (~1e6, *, ~1e6) the F64
// intermediate storage preserves the precision that the HPM-off variant
// loses when storing the composed view matrix.

import { runHpmJitterScene } from "../_shared/hpm-jitter-scene";

runHpmJitterScene({ useHighPrecisionMatrix: true }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
