// Scene 202 — Side-by-side LWR (Large World Rendering) demo.
// LEFT half = useFloatingOrigin:false (raw F32 jitter at OFFSET=5e6).
// RIGHT half = useFloatingOrigin:true (eye-relative upload path stable).
// See `../_shared/lwr-side-by-side-scene.ts` for layout details.

import { runLwrSideBySideScene } from "../_shared/lwr-side-by-side-scene";

runLwrSideBySideScene().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
