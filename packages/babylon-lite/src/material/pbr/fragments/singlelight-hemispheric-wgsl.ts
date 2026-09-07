/** Single hemispheric-light WGSL helpers for the PBR template. */

import { MAX_LIGHTS } from "../../../light/types.js";
import { wgsl } from "../../../shader/wgsl.js";

export const SINGLE_LIGHT_STRUCTS = wgsl`
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

function specularBlock(): string {
    return wgsl`let H = normalize(V + L);
let NdotH = clamp(dot(N, H), 0.0000001, 1.0);
let VdotH = saturate(dot(V, H));
let directRoughness = max(roughness, AA_factor_x);
let directAlphaG = directRoughness * directRoughness + 0.0005;
let D = distributionGGX(NdotH, directAlphaG);
let G = geometrySmithGGX(NdotL, NdotV, directAlphaG);
let coloredFresnel = fresnelSchlick(VdotH, colorF0, colorF90);
var directSpecular = coloredFresnel * D * G * NdotL * lightColor * lightAtten * material.directIntensity;`;
}

export function getSingleLightBlock(): string {
    return wgsl`let entry = lights.lights[mli(0u)];
let L = normalize(entry.vLightData.xyz);
let NdotL = dot(N, L) * 0.5 + 0.5;
let lightAtten = 1.0;
let lightColor = entry.vLightDiffuse.rgb;
let hemiDiffuse = mix(entry.vLightDirection.xyz, lightColor, NdotL);
var directDiffuse = hemiDiffuse * surfaceAlbedo * material.directIntensity;
${specularBlock()}
/*AD*/`;
}
