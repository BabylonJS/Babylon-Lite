// MEASUREMENT-ONLY local shapes entry. It isolates the renderer's no-worker size for comparison
// with the sprite benchmark; the public package exposes only worker-backed players. Not shipped.
export { createShapePlayer } from "../src/player/shapes-player.js";
export { createVectorEngine, renderLottieFrame, isPlayerReady, disposePlayer } from "../src/player/player-core.js";
export { resizeGLEngine, setGLEngineSize, disposeGLEngine, runRenderLoop, stopRenderLoop } from "babylon-lite-gl";
