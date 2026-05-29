// Scene 200 — High-Precision Matrix jitter, HPM **OFF** (F32 storage).
//
// Renders a tall pillar + four satellites at world (~1e6, *, ~1e6) with
// `useHighPrecisionMatrix: false`. The CPU-side view-projection chain is
// stored as Float32Array, which at this magnitude causes the composed view
// matrix translation and resulting view-proj to round to ULP-scale steps
// of ~0.06 m. The rendered frame is the baseline F32 output for the same
// geometry; scene 201 renders the HPM-on counterpart.
//
// Deterministic single steady frame; the parity spec
// `tests/parity/scenes/scene200-high-precision-jitter-hpm-off.spec.ts`
// screenshots and diffs against the committed golden.

import { runHpmJitterScene } from "../_shared/hpm-jitter-scene";

runHpmJitterScene({ useHighPrecisionMatrix: false }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
