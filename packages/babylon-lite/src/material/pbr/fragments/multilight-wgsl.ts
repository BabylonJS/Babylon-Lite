/** Multi-light WGSL helpers for PBR template.
 *  Separated into its own module so non-shadow PBR scenes don't pay the bundle cost. */

import { MAX_LIGHTS } from "../../../light/types.js";

export function MULTI_LIGHT_STRUCTS(): string {
    return `
struct LightEntry {
vLightData: vec4<f32>,
vLightDiffuse: vec4<f32>,
vLightSpecular: vec4<f32>,
vLightDirection: vec4<f32>,
};
struct lightsUniforms {
count: u32, _p0: u32, _p1: u32, _p2: u32,
lights: array<LightEntry, ${MAX_LIGHTS}>,
};
`;
}

export const COMPUTE_PBR_LIGHT = `
struct PbrLightResult { L: vec3<f32>, NdotL: f32, atten: f32, color: vec3<f32>, isHemi: bool };
fn computePbrLight(entry: LightEntry, N: vec3<f32>, worldPos: vec3<f32>) -> PbrLightResult {
var r: PbrLightResult;
let t = u32(entry.vLightData.w);
r.isHemi = t == 3u;
if (t == 3u) {
r.L = normalize(entry.vLightData.xyz);
r.NdotL = dot(N, r.L) * 0.5 + 0.5;
r.atten = 1.0;
r.color = mix(entry.vLightDirection.xyz, entry.vLightDiffuse.rgb, r.NdotL);
return r;
}
if (t == 1u) {
r.L = normalize(-entry.vLightData.xyz);
r.atten = 1.0;
} else {
let toLight = entry.vLightData.xyz - worldPos;
let d2 = dot(toLight, toLight);
let dist = sqrt(d2);
r.L = toLight / max(dist, 0.0001);
if (t == 2u) {
// Spot: standard linear range falloff + cone falloff (preserved from pre-glTF behaviour).
let range = entry.vLightDiffuse.a;
r.atten = max(0.0, 1.0 - dist / range);
let c = max(0.0, dot(entry.vLightDirection.xyz, -r.L));
if (c >= entry.vLightDirection.w) { r.atten *= max(0.0, pow(c, entry.vLightSpecular.a)); }
else { r.atten = 0.0; }
} else {
// Point: glTF-compatible inverse-square with smooth range cutoff.
// For infinite range (vLightDiffuse.a == MAX_VALUE) invR2 underflows to 0 and
// the smooth factor degenerates to 1, leaving pure inverse-square -- matching
// BJS's FALLOFF_GLTF (KHR_lights_punctual) and the single-light point-pbr path.
let range = entry.vLightDiffuse.a;
let invR2 = 1.0 / range / range;
let sf = d2 * invR2;
let rangeAtten = clamp(1.0 - sf * sf, 0.0, 1.0);
r.atten = (rangeAtten * rangeAtten) / max(d2, 0.0001);
}
}
r.NdotL = max(dot(N, r.L), 0.0);
r.color = entry.vLightDiffuse.rgb;
return r;
}
`;

/** The multi-light direct lighting loop WGSL block for the PBR template.
 *  Contains slot markers AD and BL for fragment injection.
 *  Generated at call time because MAX_LIGHTS is runtime-configurable via `setMaxLights`. */
export function getMultiLightLoop(): string {
    return `var directDiffuse = vec3<f32>(0.0);
var directSpecular = vec3<f32>(0.0);
// BJS direct-light specular: roughness is clamped by the geometric AA factor
// BEFORE being squared (matches BJS pbrDirectLightingFunctions.fx line 103).
// The IBL-path alphaG already has AA_factor_y additively baked in; direct
// specular uses its own squaring after max(roughness, AA_factor_x).
let directRoughness = max(roughness, AA_factor_x);
let directAlphaG = directRoughness * directRoughness + 0.0005;
var shadowFactors = array<f32, ${MAX_LIGHTS}>(${new Array(MAX_LIGHTS).fill("1.0").join(", ")});
/*AD*/
let lc = min(lights.count, ${MAX_LIGHTS}u);
for (var li = 0u; li < lc; li++) {
let entry = lights.lights[li];
let pl = computePbrLight(entry, N, input.worldPos);
let sf = shadowFactors[li];
if (pl.isHemi) {
directDiffuse += pl.color * surfaceAlbedo * material.directIntensity * sf;
} else {
directDiffuse += surfaceAlbedo * (1.0 / PI) * pl.NdotL * pl.color * pl.atten * material.directIntensity * sf;
}
let specNdotL = max(dot(N, pl.L), 0.0);
if (specNdotL > 0.0 && pl.atten > 0.0) {
let H = normalize(V + pl.L);
let NdotH = clamp(dot(N, H), 0.0000001, 1.0);
let VdotH = saturate(dot(V, H));
let D = distributionGGX(NdotH, directAlphaG);
let G = geometrySmithGGX(specNdotL, NdotV, directAlphaG);
let coloredFresnel = fresnelSchlick(VdotH, colorF0, colorF90);
directSpecular += coloredFresnel * D * G * specNdotL * pl.color * pl.atten * material.directIntensity * sf;
}
}
/*BL*/`;
}
