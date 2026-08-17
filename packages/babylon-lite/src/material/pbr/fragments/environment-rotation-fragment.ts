import type { EnvironmentSkyboxShaderPatch } from "../../../scene/scene-core.js";

const ROTATED_DIRECTION = `let cr=cos(scene.envRotationY);let sr=sin(scene.envRotationY);dir=vec3f(dir.x*cr+dir.z*sr,dir.y,-dir.x*sr+dir.z*cr);`;

/** @internal Y-rotation patch for visible environment cubemap sampling. */
export const environmentRotationSkyboxPatch: EnvironmentSkyboxShaderPatch = {
    _id: "environment-rotation",
    _apply(_kind, fragment) {
        return fragment.replace("/*ENV_DIRECTION*/", ROTATED_DIRECTION);
    },
};
