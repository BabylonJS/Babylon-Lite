import type { EnvironmentSkyboxShaderPatch } from "../../../scene/scene-core.js";

const BASE_SAMPLE = /textureSampleLevel\(\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*0(?:\.0?)?\s*\)\.rgb/;

/** @internal Fractional cubemap-LOD patch for visible environment blur. */
export const _apply: EnvironmentSkyboxShaderPatch["_apply"] = (fragment, kind) => {
    const match = fragment.match(BASE_SAMPLE);
    const cubemap = match?.[1];
    const sampler = match?.[2];
    const direction = match?.[3];
    if (!cubemap || !sampler || !direction) {
        throw new Error("Environment blur: skybox cubemap sample not found.");
    }
    const lodTail = kind === "dds" ? "0.8" : "scene.vImageInfos.z+scene._envPad2";
    const lod = `clamp(scene._envPad1*log2(f32(textureDimensions(${cubemap}).x))*${lodTail},0.0,f32(textureNumLevels(${cubemap})-1))`;
    return fragment.replace(BASE_SAMPLE, `textureSampleLevel(${cubemap},${sampler},${direction},0.0+(${lod})).rgb`);
};
