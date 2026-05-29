export {
    createSceneContext,
    onBeforeRender,
    onSceneDispose,
    addToScene,
    disposeScene,
    buildScene,
    registerScene,
    registerSceneWithShadowSupport,
    unregisterScene,
} from "./scene-core.js";
export { processMaterialSwaps } from "./scene-material-swap.js";
export type { SceneContext, SceneContextInternal, SceneContextOptions, ImageProcessingConfig, ClipPlane } from "./scene-core.js";
export { createDefaultCamera } from "./scene-camera.js";
export { removeFromScene } from "./scene-remove.js";
export { getFrameGraph } from "./scene-core.js";
