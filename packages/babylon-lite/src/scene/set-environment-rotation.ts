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

/**
 * Rotate only the image-based lighting around the Y axis, in radians. Unlike {@link setEnvironmentRotation}, this never
 * registers the visible-skybox patch, so a skybox keeps its own orientation (none, or the one given by
 * {@link setEnvironmentSkyboxRotation}). Later calls update the lighting dynamically.
 */
export function setEnvironmentLightingRotation(scene: SceneContext, rotation: number): void {
    registerEnvSceneUniforms(scene);
    scene._environmentRotation = rotation;
    _invalidateSceneUboCaches(scene);
}

/**
 * Give the visible environment skybox a fixed rotation around the Y axis, in radians, independent of the lighting
 * rotation. The angle is compiled into the skybox shader, so call it before the skybox is built. It shares the skybox
 * patch slot with {@link setEnvironmentRotation}: whichever of the two is called last before the build decides it.
 */
export function setEnvironmentSkyboxRotation(scene: SceneContext, rotation: number): void {
    _registerEnvironmentSkyboxShaderPatch(scene, 0, async () => {
        const { _rotateSkyboxDirection } = await import("../material/pbr/fragments/environment-rotation-fragment.js");
        return { _apply: (fragment) => _rotateSkyboxDirection(fragment, `f32(${rotation})`) };
    });
}
