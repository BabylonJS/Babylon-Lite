// Measurement-only local full-player entry. Mirrors the local API exported from the package root
// without retaining the root entry's worker-client exports, so flat and feature-split comparisons
// measure identical public surfaces.
export { createLottiePlayer } from "../src/player/full-player.js";
export { createVectorEngine, renderLottieFrame, isPlayerReady, disposePlayer } from "../src/player/player-core.js";
export { resizeGLEngine, setGLEngineSize, disposeGLEngine, runRenderLoop, stopRenderLoop } from "babylon-lite-gl";
