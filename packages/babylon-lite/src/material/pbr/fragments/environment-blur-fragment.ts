import type { EnvironmentSkyboxShaderPatch } from "../../../scene/scene-core.js";

const DDS_LOD = `clamp(scene._envPad1*log2(f32(textureDimensions(envCubemap).x))*0.8,0.0,f32(textureNumLevels(envCubemap)-1))`;
const HDR_LOD = `clamp(scene._envPad1*log2(f32(textureDimensions(envCubemap).x))*scene.vImageInfos.z+scene._envPad2,0.0,f32(textureNumLevels(envCubemap)-1))`;

/** @internal Fractional cubemap-LOD patch for visible environment blur. */
export const environmentBlurSkyboxPatch: EnvironmentSkyboxShaderPatch = {
    _id: "environment-blur",
    _apply(kind, fragment) {
        return fragment.replace("/*ENV_LOD*/", `+(${kind === "dds" ? DDS_LOD : HDR_LOD})`);
    },
};
