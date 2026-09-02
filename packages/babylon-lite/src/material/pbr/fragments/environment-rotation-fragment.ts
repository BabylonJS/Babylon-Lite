import type { EnvironmentSkyboxShaderPatch } from "../../../scene/scene-core.js";
import { wgsl } from "../../../shader/wgsl.js";

const BASE_DIRECTION = /var\s+([A-Za-z_]\w*)\s*=\s*normalize\(\w+\.positionUVW\)\s*;/;

/** @internal Y-rotation patch for visible environment cubemap sampling. */
export const _apply: EnvironmentSkyboxShaderPatch["_apply"] = (fragment) => {
    const direction = fragment.match(BASE_DIRECTION)?.[1];
    if (!direction) {
        throw new Error("Environment rotation: skybox direction declaration not found.");
    }
    const rotatedDirection = wgsl`let _erc=cos(scene.envRotationY);let _ers=sin(scene.envRotationY);${direction}=vec3f(${direction}.x*_erc+${direction}.z*_ers,${direction}.y,-${direction}.x*_ers+${direction}.z*_erc);`;
    return fragment.replace(BASE_DIRECTION, `$&${rotatedDirection}`);
};
