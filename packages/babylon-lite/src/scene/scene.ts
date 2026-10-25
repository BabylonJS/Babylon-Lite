export { createSceneContext, onBeforeRender, addToScene, disposeScene, buildScene, registerScene, registerSceneWithShadowSupport, unregisterScene } from "./scene-core.js";
export { onSceneChange, onSceneDispose } from "./scene-change.js";
export { processMaterialSwaps } from "./scene-material-swap.js";
export type { SceneContext, SceneContextOptions, SceneEntity, SceneChangeEvent, SceneChangeListener, ImageProcessingConfig, ClipPlane } from "./scene-core.js";
export { createDefaultCamera } from "./scene-camera.js";
export { removeFromScene } from "./scene-remove.js";
export { setSubtreeVisible as setMeshVisible } from "./visibility.js";
export { getFrameGraph } from "./scene-core.js";
