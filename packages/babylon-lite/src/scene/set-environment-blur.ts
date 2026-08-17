import { environmentBlurSkyboxPatch } from "../material/pbr/fragments/environment-blur-fragment.js";
import type { SceneContext } from "./scene-core.js";
import { _invalidateSceneUboCaches, _registerSceneUboContributor } from "./scene-ubo-extras.js";

function writeEnvironmentBlurUbo(data: Float32Array, scene: SceneContext): void {
    data[38] = scene._environmentBlur ?? 0;
    data[39] = scene._envTextures?.lodGenerationOffset ?? 0;
}

/**
 * Set continuous visible-environment blur using fractional cubemap LOD sampling.
 * Call once before the visible environment skybox is built; later calls update it dynamically.
 */
export function setEnvironmentBlur(scene: SceneContext, blur: number): void {
    scene._environmentBlur = blur;
    scene._environmentBlurSkyboxPatch = environmentBlurSkyboxPatch;
    _registerSceneUboContributor(scene, writeEnvironmentBlurUbo);
    _invalidateSceneUboCaches(scene);
}
