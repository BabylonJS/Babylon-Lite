/** Single spot-light WGSL helpers for the PBR template. */

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
let lightToFrag = entry.vLightData.xyz - input.worldPos;
let lightDist = length(lightToFrag);
let L = lightToFrag / max(lightDist, 0.0001);
let NdotL = max(dot(N, L), 0.0);
let spotC = dot(entry.vLightDirection.xyz, -L);
let physicalFalloff = material.lightFalloffMode >= 0.5;
let rangeAtt = select(max(0.0, 1.0 - lightDist / entry.vLightDiffuse.a), 1.0 / max(dot(lightToFrag, lightToFrag), 0.0000001), physicalFalloff);
let standardDirFalloff = select(0.0, max(0.0, pow(max(spotC, 0.0), entry.vLightSpecular.a)), spotC >= entry.vLightDirection.w);
let kappa = 6.64385618977 / max(1.0 - entry.vLightDirection.w, 0.0001);
let physicalDirFalloff = exp2(kappa * (spotC - 1.0));
let lightAtten = rangeAtt * select(standardDirFalloff, physicalDirFalloff, physicalFalloff);
let lightColor = entry.vLightDiffuse.rgb;
var directDiffuse = surfaceAlbedo * (1.0 / PI) * NdotL * lightColor * lightAtten * material.directIntensity;
${specularBlock()}
/*AD*/`;
}
