import { _registerEnvironmentSkyboxShaderPatch } from "../material/pbr/environment-skybox-shader-composer.js";
import type { EnvironmentSkyboxShaderPatchLoader, SceneContext } from "./scene-core.js";
import { _invalidateSceneUboCaches, registerEnvSceneUniforms } from "./scene-ubo-extras.js";

// Rotation also affects IBL lighting, so keep the visible-skybox patch lazy for lighting-only consumers.
const loadRotationSkyboxPatch: EnvironmentSkyboxShaderPatchLoader = () => import("../material/pbr/fragments/environment-rotation-fragment.js");

/**
 * Set environment rotation around the Y axis, in radians.
 * Call once before the visible environment skybox is built; later calls update it dynamically.
 */
export function setEnvironmentRotation(scene: SceneContext, rotation: number): void {
    registerEnvSceneUniforms(scene);
    scene._environmentRotation = rotation;
    _registerEnvironmentSkyboxShaderPatch(scene, 0, loadRotationSkyboxPatch);
    _invalidateSceneUboCaches(scene);
}
