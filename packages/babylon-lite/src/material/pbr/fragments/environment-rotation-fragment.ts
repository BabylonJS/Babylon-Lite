import type { EnvironmentSkyboxShaderPatch } from "../../../scene/scene-core.js";

const ROTATED_DIRECTION = `let cr=cos(scene.envRotationY);let sr=sin(scene.envRotationY);dir=vec3f(dir.x*cr+dir.z*sr,dir.y,-dir.x*sr+dir.z*cr);`;
const BASE_DIRECTION = /var dir\s*=\s*normalize\([^;]+;/;

/** @internal Y-rotation patch for visible environment cubemap sampling. */
export const _apply: EnvironmentSkyboxShaderPatch["_apply"] = (fragment) => {
    if (!BASE_DIRECTION.test(fragment)) {
        throw new Error("Environment rotation: skybox direction declaration not found.");
    }
    return fragment.replace(BASE_DIRECTION, `$&${ROTATED_DIRECTION}`);
};
