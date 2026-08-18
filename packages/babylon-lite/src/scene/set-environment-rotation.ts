import type { SceneContext } from "./scene-core.js";
import { _invalidateSceneUboCaches, registerEnvSceneUniforms } from "./scene-ubo-extras.js";

/**
 * Set environment rotation around the Y axis, in radians.
 * Call once before the visible environment skybox is built; later calls update it dynamically.
 */
export function setEnvironmentRotation(scene: SceneContext, rotation: number): void {
    registerEnvSceneUniforms(scene);
    scene._environmentRotation = rotation;
    scene._environmentRotationSkyboxPatch = true;
    _invalidateSceneUboCaches(scene);
}
