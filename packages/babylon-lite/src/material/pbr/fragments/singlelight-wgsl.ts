/** Single-light WGSL helpers for the PBR template.
 *  Used for exactly one non-shadow affected mesh light; avoids the generic multi-light loop. */

import { MAX_LIGHTS } from "../../../light/types.js";

export const SINGLE_LIGHT_STRUCTS = `
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
    return `let H = normalize(V + L);
let NdotH = clamp(dot(N, H), 0.0000001, 1.0);
let VdotH = saturate(dot(V, H));
let directRoughness = max(roughness, AA_factor_x);
let directAlphaG = directRoughness * directRoughness + 0.0005;
let D = distributionGGX(NdotH, directAlphaG);
let G = geometrySmithGGX(NdotL, NdotV, directAlphaG);
let coloredFresnel = fresnelSchlick(VdotH, colorF0, colorF90);
var directSpecular = coloredFresnel * D * G * NdotL * lightColor * lightAtten * material.directIntensity;`;
}

export function getSingleLightBlock(type: string): string {
    let light = "";
    if (type === "hemispheric") {
        light = `let entry = lights.lights[mli(0u)];
let L = normalize(entry.vLightData.xyz);
let NdotL = dot(N, L) * 0.5 + 0.5;
let lightAtten = 1.0;
let lightColor = entry.vLightDiffuse.rgb;
let hemiDiffuse = mix(entry.vLightDirection.xyz, lightColor, NdotL);
var directDiffuse = hemiDiffuse * surfaceAlbedo * material.directIntensity;`;
    } else if (type === "directional") {
        light = `let entry = lights.lights[mli(0u)];
let L = normalize(-entry.vLightData.xyz);
let NdotL = max(dot(N, L), 0.0);
let lightAtten = 1.0;
let lightColor = entry.vLightDiffuse.rgb;
var directDiffuse = surfaceAlbedo * (1.0 / PI) * NdotL * lightColor * material.directIntensity;`;
    } else if (type === "spot") {
        light = `let entry = lights.lights[mli(0u)];
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
var directDiffuse = surfaceAlbedo * (1.0 / PI) * NdotL * lightColor * lightAtten * material.directIntensity;`;
    } else {
        light = `let entry = lights.lights[mli(0u)];
let lightToFrag = entry.vLightData.xyz - input.worldPos;
let lightDist2 = dot(lightToFrag, lightToFrag);
let L = normalize(lightToFrag);
let NdotL = max(dot(N, L), 0.0);
let range = entry.vLightDiffuse.a;
let physicalFalloff = material.lightFalloffMode >= 0.5;
let physicalAtten = 1.0 / max(lightDist2, 0.0001);
let standardAtten = max(0.0, 1.0 - sqrt(lightDist2) / range);
let lightAtten = select(standardAtten, physicalAtten, physicalFalloff);
let lightColor = entry.vLightDiffuse.rgb;
var directDiffuse = surfaceAlbedo * (1.0 / PI) * NdotL * lightColor * lightAtten * material.directIntensity;`;
    }
    return `${light}
${specularBlock()}
/*AD*/`;
}
