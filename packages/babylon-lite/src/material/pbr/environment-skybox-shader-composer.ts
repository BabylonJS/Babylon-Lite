import type { EnvironmentSkyboxShaderPatchLoader, SceneContext } from "../../scene/scene-core.js";
import { SCENE_UBO_WGSL } from "../../shader/scene-uniforms.js";

/** @internal Register one feature-owned skybox shader patch on a scene. */
export function _registerEnvironmentSkyboxShaderPatch(scene: SceneContext, order: number, loadPatch: EnvironmentSkyboxShaderPatchLoader): void {
    const loaders = (scene._environmentSkyboxShaderPatchLoaders ??= []);
    loaders[order] = loadPatch;
    scene._environmentSkyboxShaderComposer ??= async (fragment, kind) => {
        fragment = kind === "hdr" ? SCENE_UBO_WGSL + fragment : fragment;
        for (const load of loaders.slice()) {
            if (load) {
                fragment = (await load())._apply(fragment, kind);
            }
        }
        return fragment;
    };
}
