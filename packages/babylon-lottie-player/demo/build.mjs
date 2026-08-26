// Build the standalone viewer/validation harness once: esbuild-bundle demo/main.ts (which imports
// the package source + babylon-lite-gl from source) into demo/dist, and stage page + anims + manifest.
// Used by the screenshot pipeline (screenshot.mjs serves the resulting dist). For a live, auto-
// rebuilding viewer use serve.mjs instead.
//
//   node packages/babylon-lottie-player/demo/build.mjs
import { build } from "esbuild";
import { mainBuildOptions, workerBuildOptions, stageAssets, DIST } from "./_shared.mjs";

const manifest = stageAssets();
await Promise.all([build(mainBuildOptions), build(workerBuildOptions)]);
console.log(`built -> ${DIST}`);
console.log(`anims: ${manifest.join(", ")}`);
