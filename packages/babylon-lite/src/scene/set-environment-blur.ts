import * as environmentBlurSkyboxPatch from "../material/pbr/fragments/environment-blur-fragment.js";
import { _registerEnvironmentSkyboxShaderPatch } from "../material/pbr/environment-skybox-shader-composer.js";
import type { EnvironmentSkyboxShaderPatchLoader, SceneContext } from "./scene-core.js";
import { _invalidateSceneUboCaches, _registerSceneUboContributor } from "./scene-ubo-extras.js";

// Blur only affects the visible skybox, so importing its patch here charges only callers that explicitly opt in.
const loadBlurSkyboxPatch: EnvironmentSkyboxShaderPatchLoader = () => environmentBlurSkyboxPatch;

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
    _registerEnvironmentSkyboxShaderPatch(scene, 1, loadBlurSkyboxPatch);
    _registerSceneUboContributor(scene, writeEnvironmentBlurUbo);
    _invalidateSceneUboCaches(scene);
}
