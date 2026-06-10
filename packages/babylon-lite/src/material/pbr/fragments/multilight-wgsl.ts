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
struct PbrLightResult { L: vec3<f32>, NdotL: f32, atten: f32, color: vec3<f32>, specColor: vec3<f32>, isHemi: bool };
fn computePbrLight(entry: LightEntry, N: vec3<f32>, worldPos: vec3<f32>, lightFalloffMode: f32) -> PbrLightResult {
var r: PbrLightResult;
let t = u32(entry.vLightData.w);
r.isHemi = t == 3u;
r.specColor = entry.vLightDiffuse.rgb;
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
        let physicalFalloff = lightFalloffMode >= 0.5;
        let rangeAtt = select(max(0.0, 1.0 - dist / entry.vLightDiffuse.a), 1.0 / max(d2, 0.0000001), physicalFalloff);
        if (t == 2u) {
        let cosHalfAngle = entry.vLightDirection.w;
        let c = dot(-entry.vLightDirection.xyz, r.L);
        let standardDirFalloff = select(0.0, max(0.0, pow(max(c, 0.0), entry.vLightSpecular.a)), c >= cosHalfAngle);
        let kappa = 6.64385618977 / max(1.0 - cosHalfAngle, 0.0001);
        let physicalDirFalloff = exp2(kappa * (c - 1.0));
        r.atten = rangeAtt * select(standardDirFalloff, physicalDirFalloff, physicalFalloff);
        } else {
        r.atten = rangeAtt;
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
let lightCount = min(mesh.lc, ${MAX_LIGHTS}u);
/*AS*/
// First-light aliases — kept at directLightBlock scope so the AD slot below
// (clearcoat / sheen / subsurface) sees the same single-light variable names
// it was originally written against. Multi-light direct contributions
// for those ancillary BRDFs are not yet supported (single-light parity only).
let lightIndex0 = mli(0u);
let entry0 = lights.lights[lightIndex0];
let pl0 = computePbrLight(entry0, N, input.worldPos, material.lightFalloffMode);
let L = pl0.L;
let NdotL = pl0.NdotL;
let lightColor = pl0.specColor;
let lightAtten = pl0.atten * shadowFactors[lightIndex0];
let H = normalize(V + L);
let NdotH = clamp(dot(N, H), 0.0000001, 1.0);
let VdotH = saturate(dot(V, H));
for (var li = 0u; li < lightCount; li++) {
var pl: PbrLightResult;
let lightIndex = mli(li);
if (li == 0u) { pl = pl0; } else { pl = computePbrLight(lights.lights[lightIndex], N, input.worldPos, material.lightFalloffMode); }
let sf = shadowFactors[lightIndex];
if (pl.isHemi) {
directDiffuse += pl.color * surfaceAlbedo * material.directIntensity * sf;
} else {
directDiffuse += surfaceAlbedo * (1.0 / PI) * pl.NdotL * pl.color * pl.atten * material.directIntensity * sf;
}
// Specular uses pl.NdotL (hemispheric 0.5+0.5*dot for hemi, max(dot,0) for others)
// and pl.specColor (un-mixed light diffuse — matches single-light fast path
// and Std's LIGHTING_FN which uses vLightSpecular for the specular bounce).
if (pl.NdotL > 0.0 && pl.atten > 0.0) {
let specH = normalize(V + pl.L);
let specNdotH = clamp(dot(N, specH), 0.0000001, 1.0);
let specVdotH = saturate(dot(V, specH));
let D = distributionGGX(specNdotH, directAlphaG);
let G = geometrySmithGGX(pl.NdotL, NdotV, directAlphaG);
let coloredFresnel = fresnelSchlick(specVdotH, colorF0, colorF90);
directSpecular += coloredFresnel * D * G * pl.NdotL * pl.specColor * pl.atten * material.directIntensity * sf;
}
}
/*AD*/`;
}
