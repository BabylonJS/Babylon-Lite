/** Shared WGSL helper snippets used by both PBR and Standard material systems.
 *
 *  These are pure WGSL function strings — no bindings, no UBO declarations.
 *  Each material system wraps them with its own binding declarations. */

/** Cotangent-frame bump mapping.
 *  Requires: `bT` (texture_2d) and `bS` (sampler) in scope. */
export const WGSL_PERTURB_NORMAL = `
fn perturbNormal(vNormalW: vec3<f32>, positionW: vec3<f32>, uv: vec2<f32>, bumpScale: f32) -> vec3<f32> {
let normalSample = textureSample(bT, bS, uv).rgb * 2.0 - 1.0;
let N = normalize(vNormalW) * bumpScale;
let dp1 = dpdx(positionW);
let dp2 = -dpdy(positionW);
let duv1 = dpdx(uv);
let duv2 = -dpdy(uv);
let dp2perp = cross(dp2, N);
let dp1perp = cross(N, dp1);
var tangent = dp2perp * duv1.x + dp1perp * duv2.x;
var bitangent = dp2perp * duv1.y + dp1perp * duv2.y;
let det = max(dot(tangent, tangent), dot(bitangent, bitangent));
let invmax = select(inverseSqrt(det), 0.0, det == 0.0);
let cotangentFrame = mat3x3<f32>(tangent * invmax, bitangent * invmax, N);
return normalize(cotangentFrame * normalSample);
}
`;

/** ESM shadow helper functions.
 *  Requires: `shadowTex` (texture_2d), `shadowSampler` (sampler) in scope. */
export const WGSL_SHADOW_ESM = `
fn computeFallOff(value: f32, clipSpace: vec2<f32>, frustumEdgeFalloff: f32) -> f32 {
let mask = smoothstep(1.0 - frustumEdgeFalloff, 1.00000012, clamp(dot(clipSpace, clipSpace), 0.0, 1.0));
return mix(value, 1.0, mask);
}
fn computeShadowWithESM(posFromLight: vec4<f32>, depthMetric: f32, darkness: f32, depthScale: f32, frustumEdgeFalloff: f32) -> f32 {
let clipSpace = posFromLight.xyz / posFromLight.w;
let uv = vec2<f32>(0.5 * clipSpace.x + 0.5, 0.5 - 0.5 * clipSpace.y);
if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
let shadowPixelDepth = clamp(depthMetric, 0.0, 1.0);
let shadowMapSample = textureSampleLevel(shadowTex, shadowSampler, uv, 0.0).x;
let esm = 1.0 - clamp(exp(min(87.0, depthScale * shadowPixelDepth)) * shadowMapSample, 0.0, 1.0 - darkness);
return computeFallOff(esm, clipSpace.xy, frustumEdgeFalloff);
}
`;

/** Fog calculation helper.
 *  Requires: `scene.vFogInfos` (vec4) in scope. */
export const WGSL_FOG = `
const E_FOG: f32 = 2.71828;
fn calcFogFactor(fogDistance: vec3<f32>) -> f32 {
var fogCoeff: f32 = 1.0;
let fogMode = scene.vFogInfos.x;
let fogStart = scene.vFogInfos.y;
let fogEnd = scene.vFogInfos.z;
let fogDensity = scene.vFogInfos.w;
let dist = length(fogDistance);
if (fogMode == 3.0) { fogCoeff = (fogEnd - dist) / (fogEnd - fogStart); }
else if (fogMode == 1.0) { fogCoeff = 1.0 / pow(E_FOG, dist * fogDensity); }
else if (fogMode == 2.0) { fogCoeff = 1.0 / pow(E_FOG, dist * dist * fogDensity * fogDensity); }
return clamp(fogCoeff, 0.0, 1.0);
}
`;

/** Dither noise function.
 *  Pure math — no UBO dependency. */
export const WGSL_DITHER = `
fn dither(seed: vec2<f32>, varianceAmount: f32) -> f32 {
let rand = fract(sin(dot(seed, vec2<f32>(12.9898, 78.233))) * 43758.5453);
let normVariance = varianceAmount / 255.0;
return mix(-normVariance, normVariance, rand);
}
`;

/** Noise-disabled replacement for shaders that still call dither(). */
export const WGSL_NO_DITHER = "fn dither(a:vec2<f32>,b:f32)->f32{return 0.0;}";
