// MEASUREMENT-ONLY size entry for lottie-react (^2.3.1) — a production Lottie player used in some
// products. lottie-react is a thin React wrapper over lottie-web, the reference CPU renderer
// (SVG/Canvas2D). We measure it the SAME way as the other players (esbuild minify + treeShaking +
// gzip L9) with React marked EXTERNAL by the size tooling — a React app already ships React, so this
// isolates the incremental Lottie bytes (the lottie-react wrapper + the lottie-web engine).
//
// Consumed from npm (like the Babylon.js player), pinned to the version products use. Not shipped.
import Lottie from "lottie-react";

export function run(): typeof Lottie {
    return Lottie;
}

(globalThis as unknown as { __run?: unknown }).__run = run;
