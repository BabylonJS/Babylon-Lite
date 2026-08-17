import { environmentRotationSkyboxPatch } from "../material/pbr/fragments/environment-rotation-fragment.js";
import type { SceneContext } from "./scene-core.js";
import { registerEnvSceneUniforms } from "./scene-ubo-extras.js";

/**
 * Set environment rotation around the Y axis, in radians.
 * Call once before the visible environment skybox is built; later calls update it dynamically.
 */
export function setEnvironmentRotation(scene: SceneContext, rotation: number): void {
    registerEnvSceneUniforms(scene);
    scene.envRotationY = rotation;
    scene._environmentRotationSkyboxPatch = environmentRotationSkyboxPatch;
}
