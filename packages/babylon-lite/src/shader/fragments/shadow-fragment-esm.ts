import type { ShadowAlgorithm } from "./shadow-algorithms.js";
import { wgsl } from "../wgsl.js";

export const shadowAlgorithm: ShadowAlgorithm = {
    shadowTexture: { _kind: "texture", _textureType: "texture_2d<f32>" },
    shadowSamplerName: "shadowSamp",
    shadowSampler: { _kind: "sampler", _samplerType: "sampler" },
    shadowFragmentLine(lightIndex, suffix, factors = "shadowFactors") {
        const info = `shadowInfo${suffix}.shadowsInfo`;
        return wgsl`${factors}[${lightIndex}] = computeShadowESM${suffix}(input.vPosFromLight${suffix}, input.vDepthMetric${suffix}, ${info}.x, ${info}.z, ${info}.w);`;
    },
    shadowHelper(suffix, projection) {
        return wgsl`
fn computeFallOff${suffix}(value: f32, clipSpace: vec2<f32>, frustumEdgeFalloff: f32) -> f32 {
let mask = smoothstep(1.0 - frustumEdgeFalloff, 1.00000012, clamp(dot(clipSpace, clipSpace), 0.0, 1.0));
return mix(value, 1.0, mask);
}
fn computeShadowESM${suffix}(posFromLight: vec4<f32>, depthMetric: f32, darkness: f32, depthScale: f32, frustumEdgeFalloff: f32) -> f32 {
if (darkness >= 1.0) { return 1.0; }
${projection}
let shadowPixelDepth = clamp(depthMetric, 0.0, 1.0);
let shadowMapSample = textureSampleLevel(shadowTex${suffix}, shadowSamp${suffix}, uv, 0.0).x;
let esm = 1.0 - clamp(exp(min(87.0, depthScale * shadowPixelDepth)) * shadowMapSample, 0.0, 1.0 - darkness);
return computeFallOff${suffix}(esm, clipSpace.xy, frustumEdgeFalloff);
}`;
    },
};
