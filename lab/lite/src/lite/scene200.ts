// Scene 200 — High-Precision Matrix jitter, HPM **OFF**, floating-origin **OFF**.
//
// The "bad case". Renders a tall pillar + four satellites at world
// (~1e6, *, ~1e6) with `useHighPrecisionMatrix: false` and
// `useFloatingOrigin: false`. CPU-side matrix storage is Float32Array;
// no eye-relative offset is applied at upload. At this magnitude F32
// ULP on the translation column is ~0.06 m, which surfaces as visible
// stair-stepping / jitter on cube edges.
//
// Scene 201 is the matching "good case" (HPM-on, FO-on). The parity
// proof is that the two scenes MUST diverge — see
// tests/unit/hpm-divergence.test.ts.

import { runHpmJitterScene } from "../_shared/hpm-jitter-scene";

runHpmJitterScene({ useHighPrecisionMatrix: false, useFloatingOrigin: false }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
