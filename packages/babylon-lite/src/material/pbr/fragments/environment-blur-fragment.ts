import type { EnvironmentSkyboxShaderPatch } from "../../../scene/scene-core.js";

const DDS_LOD = `clamp(scene._envPad1*log2(f32(textureDimensions(envCubemap).x))*0.8,0.0,f32(textureNumLevels(envCubemap)-1))`;
const HDR_LOD = `clamp(scene._envPad1*log2(f32(textureDimensions(envCubemap).x))*scene.vImageInfos.z+scene._envPad2,0.0,f32(textureNumLevels(envCubemap)-1))`;
const BASE_LOD = /dir,\s*0\.0\)\.rgb/;

/** @internal Fractional cubemap-LOD patch for visible environment blur. */
export const _apply: EnvironmentSkyboxShaderPatch["_apply"] = (fragment, kind) => {
    if (!BASE_LOD.test(fragment)) {
        throw new Error("Environment blur: skybox cubemap sample not found.");
    }
    return fragment.replace(BASE_LOD, `dir,0.0+(${kind === "dds" ? DDS_LOD : HDR_LOD})).rgb`);
};
