/**
 * Clearcoat Fragment
 *
 * Adds a glossy transparent top layer (like car paint or lacquered surfaces).
 * Only bundled when a scene uses PbrMaterialProps.clearCoat.
 *
 * Math follows BJS PBRClearCoatConfiguration:
 *  - F0 from IOR: ((1-ior)/(1+ior))^2
 *  - F0 remap: base F0 adjusted for coat/base interface
 *  - Direct: GGX + Kelemen visibility + Schlick fresnel
 *  - IBL: Jones analytical BRDF (not BRDF LUT)
 *  - Conservation: base layer attenuated by (1 - fresnel * intensity)
 *
 * Supports glTF KHR_materials_clearcoat textures:
 *  - clearcoatTexture (R channel multiplies intensity)
 *  - clearcoatRoughnessTexture (G channel multiplies roughness)
 *  - clearcoatNormalTexture (tangent-space normal, perturbs coat normal)
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";

const CC_HELPERS = `
fn visibility_Kelemen(VdotH_kl: f32) -> f32 {
return 0.25 / (VdotH_kl * VdotH_kl + 0.0000001);
}
fn getR0RemappedForClearCoat(f0_rc: vec3<f32>, ccA: f32, ccB: f32) -> vec3<f32> {
let sf0 = sqrt(f0_rc);
let num = ccA + ccB * sf0;
let den = ccB + ccA * sf0;
return saturate((num / den) * (num / den));
}
`;

// WGSL fragment: coat-layer normal. Computes ccN (coat world-space normal)
// using a locally-derived cotangent frame from world-position and UV derivatives.
// Emitted in /*AC*/ so ccN is in scope for direct + IBL blocks.
const CC_NORMAL_COMPUTE = `
let cc_dp1 = dpdx(input.worldPos);
let cc_dp2 = dpdy(input.worldPos);
let cc_duv1 = dpdx(input.uv);
let cc_duv2 = dpdy(input.uv);
let cc_dp2perp = cross(cc_dp2, N_geom);
let cc_dp1perp = cross(N_geom, cc_dp1);
let cc_tFrame = cc_dp2perp * cc_duv1.x + cc_dp1perp * cc_duv2.x;
let cc_bFrame = -(cc_dp2perp * cc_duv1.y + cc_dp1perp * cc_duv2.y);
let cc_det = max(dot(cc_tFrame, cc_tFrame), dot(cc_bFrame, cc_bFrame));
let cc_invmax = select(inverseSqrt(cc_det), 0.0, cc_det == 0.0);
let cc_frame = mat3x3<f32>(cc_tFrame * cc_invmax, cc_bFrame * cc_invmax, N_geom);
let ccNormSampleRaw = textureSample(ccNormalTexture, ccNormalSampler_, input.uv).rgb * 2.0 - 1.0;
let ccNormScale = material.ccParams.z;
var ccN = normalize(cc_frame * normalize(ccNormSampleRaw * vec3<f32>(ccNormScale, ccNormScale, 1.0)));
`;

function makeF0Remap(hasIntensityMap: boolean): string {
    const intensityExpr = hasIntensityMap ? `material.ccParams.x * textureSample(ccIntensityTexture, ccIntensitySampler_, input.uv).r` : `material.ccParams.x`;
    return `
{
let ccInt_r = ${intensityExpr};
let ccA_r = material.ccRefractionParams.z;
let ccB_r = material.ccRefractionParams.w;
let remappedF0 = getR0RemappedForClearCoat(colorF0, ccA_r, ccB_r);
colorF0 = mix(colorF0, remappedF0, ccInt_r);
}
`;
}

function makeDirectMod(hasIntensityMap: boolean, hasRoughnessMap: boolean, hasNormalMap: boolean): string {
    const intensityExpr = hasIntensityMap ? `material.ccParams.x * textureSample(ccIntensityTexture, ccIntensitySampler_, input.uv).r` : `material.ccParams.x`;
    const roughnessExpr = hasRoughnessMap ? `clamp(material.ccParams.y * textureSample(ccRoughnessTexture, ccRoughnessSampler_, input.uv).g, 0.0, 1.0)` : `material.ccParams.y`;
    // If coat has its own normal, compute NdotL/NdotH/VdotH using ccN. Otherwise use geometric normal
    // (BJS: clearCoatNormalW defaults to geometricNormalW).
    const ccAngles = hasNormalMap
        ? `let ccNdotL_dl = saturate(dot(ccN, L));
let ccH_dl = normalize(V + L);
let ccNdotH_dl = clamp(dot(ccN, ccH_dl), 0.0000001, 1.0);
let ccVdotH_dl = saturate(dot(V, ccH_dl));`
        : `let ccNdotL_dl = saturate(dot(N_geom, L));
let ccH_dl = normalize(V + L);
let ccNdotH_dl = clamp(dot(N_geom, ccH_dl), 0.0000001, 1.0);
let ccVdotH_dl = saturate(dot(V, ccH_dl));`;
    return `
var ccDirectAttenuation = 1.0;
var ccDirectSpecularTerm = vec3<f32>(0.0);
{
let ccInt_dl = ${intensityExpr};
let ccRough_dl = ${roughnessExpr};
let ccF0_dl = material.ccRefractionParams.x;
let ccAlphaG_dl = ccRough_dl * ccRough_dl + 0.0005;
${ccAngles}
let ccD_dl = distributionGGX(ccNdotH_dl, ccAlphaG_dl);
let ccVis_dl = visibility_Kelemen(ccVdotH_dl);
let cc_t_dl = 1.0 - ccVdotH_dl;
let cc_t2_dl = cc_t_dl * cc_t_dl;
let ccFresnel_dl = ccF0_dl + (1.0 - ccF0_dl) * (cc_t2_dl * cc_t2_dl * cc_t_dl);
let ccTerm = ccFresnel_dl * ccD_dl * ccVis_dl * ccNdotL_dl;
ccDirectSpecularTerm = vec3<f32>(ccTerm) * lightColor * lightAtten * material.directIntensity * ccInt_dl;
ccDirectAttenuation = 1.0 - ccFresnel_dl * ccInt_dl;
}
`;
}

function makeIblMod(hasIntensityMap: boolean, hasRoughnessMap: boolean, hasNormalMap: boolean, hasSpecularAA: boolean, hasBaseNormalMap: boolean): string {
    const intensityExpr = hasIntensityMap ? `material.ccParams.x * textureSample(ccIntensityTexture, ccIntensitySampler_, input.uv).r` : `material.ccParams.x`;
    const roughnessExpr = hasRoughnessMap ? `clamp(material.ccParams.y * textureSample(ccRoughnessTexture, ccRoughnessSampler_, input.uv).g, 0.0, 1.0)` : `material.ccParams.y`;
    // Use coat's own normal for reflection when ccNormal map is present.
    // Otherwise, use geometric normal (matches BJS: clearCoatNormalW = geometricNormalW).
    const reflDir = hasNormalMap
        ? `let ccR_raw = reflect(-V, ccN);
let ccR_ibl = rotateY(ccR_raw, scene.envRotationY);
let ccNdotV_ibl = abs(dot(ccN, V)) + 0.0000001;`
        : `let ccR_raw = reflect(-V, N_geom);
let ccR_ibl = rotateY(ccR_raw, scene.envRotationY);
let ccNdotV_ibl = abs(dot(N_geom, V)) + 0.0000001;`;
    const ccNormalForAA = hasNormalMap ? "ccN" : "N_geom";
    const alphaG = hasSpecularAA
        ? `let ccAlphaG_ibl_base = ccRough_ibl * ccRough_ibl + 0.0005;
let cc_nDfdx_AA = dpdx(${ccNormalForAA});
let cc_nDfdy_AA = dpdy(${ccNormalForAA});
let cc_slopeSquare_AA = max(dot(cc_nDfdx_AA, cc_nDfdx_AA), dot(cc_nDfdy_AA, cc_nDfdy_AA));
let ccAlphaG_ibl = ccAlphaG_ibl_base + sqrt(cc_slopeSquare_AA) * 0.75;`
        : `let ccAlphaG_ibl = ccRough_ibl * ccRough_ibl + 0.0005;`;
    // Horizon occlusion: BJS attenuates the clearcoat environment reflectance by EHO when
    // the base material has a normal map (the BUMP define). Matches pbrBlockClearcoat.fx.
    // When the coat normal equals the geometric normal, eho≈1 (no effect).
    const ccNormalForEho = hasNormalMap ? "ccN" : "N_geom";
    const ehoLine = hasBaseNormalMap ? `let ccEho_ibl = environmentHorizonOcclusion(-V, ${ccNormalForEho}, N_geom);` : `let ccEho_ibl = 1.0;`;
    return `
{
let ccInt_ibl = ${intensityExpr};
let ccRough_ibl = ${roughnessExpr};
let ccF0_ibl = material.ccRefractionParams.x;
${reflDir}
${alphaG}
var ccSpecLod_ibl = log2(cubemapDim * ccAlphaG_ibl) * scene.lodGenerationScale;
let ccEnvRadiance_ibl = textureSampleLevel(iblTexture, iblSampler, ccR_ibl, clamp(ccSpecLod_ibl, 0.0, maxLod)).rgb * material.environmentIntensity;
let ccBrdf_ibl = textureSample(brdfLUT, brdfSampler_, vec2<f32>(ccNdotV_ibl, ccRough_ibl)).rgb;
${ehoLine}
let ccSpecEnvRefl = (vec3<f32>(ccF0_ibl) * ccBrdf_ibl.y + (vec3<f32>(1.0) - vec3<f32>(ccF0_ibl)) * ccBrdf_ibl.x) * ccInt_ibl * ccEho_ibl;
let cc_t_ibl = 1.0 - ccNdotV_ibl;
let cc_t2_ibl = cc_t_ibl * cc_t_ibl;
let ccFresnelIBL = ccF0_ibl + (1.0 - ccF0_ibl) * (cc_t2_ibl * cc_t2_ibl * cc_t_ibl);
let ccConservation_ibl = 1.0 - ccFresnelIBL * ccInt_ibl;
let ccFinalRadiance_ibl = ccEnvRadiance_ibl * ccSpecEnvRefl;
color = finalIrradiance * ccConservation_ibl
      + finalRadianceScaled * ccConservation_ibl
      + finalSpecularScaled * ccDirectAttenuation
      + directDiffuse * ccDirectAttenuation
      + ccDirectSpecularTerm
      + ccFinalRadiance_ibl
      + emissive;
}
`;
}

function makeNonIblMod(hasIntensityMap: boolean): string {
    const intensityExpr = hasIntensityMap ? `material.ccParams.x * textureSample(ccIntensityTexture, ccIntensitySampler_, input.uv).r` : `material.ccParams.x`;
    return `
{
let ccF0_noIbl = material.ccRefractionParams.x;
let ccInt_noIbl = ${intensityExpr};
let cc_t_noIbl = 1.0 - NdotV;
let cc_t2_noIbl = cc_t_noIbl * cc_t_noIbl;
let ccFresnelNoIbl = ccF0_noIbl + (1.0 - ccF0_noIbl) * (cc_t2_noIbl * cc_t2_noIbl * cc_t_noIbl);
let ccCons_noIbl = 1.0 - ccFresnelNoIbl * ccInt_noIbl;
let attColor = (color - emissive) * ccCons_noIbl + emissive + ccDirectSpecularTerm;
color = attColor;
}
`;
}

export function createClearcoatFragment(
    hasIbl: boolean,
    hasReflectance = false,
    hasIntensityMap = false,
    hasRoughnessMap = false,
    hasNormalMap = false,
    disableF0Remap = false,
    hasSpecularAA = false,
    hasBaseNormalMap = false
): ShaderFragment {
    const slots: Partial<Record<string, string>> = {
        MF: disableF0Remap ? "" : makeF0Remap(hasIntensityMap),
        AD: makeDirectMod(hasIntensityMap, hasRoughnessMap, hasNormalMap),
        BL: `var ccDirectAttenuation = 1.0;\nvar ccDirectSpecularTerm = vec3<f32>(0.0);`,
    };
    if (hasNormalMap) {
        slots.AC = CC_NORMAL_COMPUTE;
    }
    // AI and NI are mutually exclusive — only one path runs
    if (hasIbl) {
        slots.AI = makeIblMod(hasIntensityMap, hasRoughnessMap, hasNormalMap, hasSpecularAA, hasBaseNormalMap);
    } else {
        slots.NI = makeNonIblMod(hasIntensityMap);
    }
    const deps: string[] = [];
    if (hasIbl) {
        deps.push("ibl");
    }
    if (hasReflectance) {
        deps.push("reflectance");
    }
    // Fragment id varies with texture config so shader-composer's fragmentKey
    // (and downstream pipeline cache) distinguishes variants.
    const suffix =
        (hasIntensityMap ? "I" : "") +
        (hasRoughnessMap ? "R" : "") +
        (hasNormalMap ? "N" : "") +
        (disableF0Remap ? "X" : "") +
        (hasSpecularAA ? "A" : "") +
        (hasBaseNormalMap ? "B" : "");
    return {
        id: suffix ? `clearcoat-${suffix}` : "clearcoat",
        dependencies: deps.length > 0 ? deps : undefined,

        // UBO fields are in the PBR template's baseMeshUboFields for byte-layout compat.

        helperFunctions: CC_HELPERS,

        fragmentSlots: slots,
    };
}
