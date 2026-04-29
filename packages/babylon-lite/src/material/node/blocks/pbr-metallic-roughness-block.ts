/** PBRMetallicRoughnessBlock — direct lighting + optional IBL + optional clearcoat + optional sheen.
 *
 *  When the `reflection` input is connected (typically to a ReflectionBlock),
 *  this emitter runs the GGX direct-lighting path PLUS a split-sum IBL
 *  contribution (specular cube + BRDF LUT + SH irradiance).
 *
 *  When the `clearcoat` input is connected (to a ClearCoatBlock), an extra
 *  GGX clear-coat layer is added on top: per-light Schlick fresnel + Kelemen
 *  visibility GGX specular, and the base layer (diffuse + specular + IBL)
 *  is modulated by (1 - ccFresnel * ccIntensity).
 *
 *  When the `sheen` input is connected (to a SheenBlock), an extra Charlie
 *  NDF + Ashikhmin visibility cloth/velvet sheen layer is added: per-light
 *  direct sheen contribution and a sheen IBL term that uses the BRDF LUT
 *  blue channel for the sheen-roughness lookup.
 *
 *  Outputs implemented (others stub to a zero vector):
 *    - lighting / diffuseDir / specularDir / shadow / alpha
 *    - diffuseInd / specularInd (only meaningful when IBL is on)
 */

import type { BlockEmitter, NodeBlock, NodeBuildState, NodeEmitContext, Stage } from "../node-types.js";
import { MAX_LIGHTS } from "../../../light/types.js";

const HELPER_KEY_PREFIX = "nme_pbr_mr";

function ccDirectBlock(useClearcoat: boolean, useCcBump: boolean, useCcTint: boolean): string {
    if (!useClearcoat) {
        return "";
    }
    const Ncc = useCcBump ? "ccNormalW" : "N";
    const NdotLcc = useCcBump ? "ccNdotL" : "NdotL";
    const declCcNdotL = useCcBump ? `let ccNdotL = clamp(dot(ccNormalW, L), 0.0000001, 1.0);` : ``;
    return `
        ${declCcNdotL}
        if (${NdotLcc} > 0.0 && atten > 0.0) {
            let ccH = normalize(V + L);
            let ccNdotH = clamp(dot(${Ncc}, ccH), 0.0000001, 1.0);
            let ccVdotH = saturate(dot(V, ccH));
            let ccD = nme_pbr_distGGX(ccNdotH, ccAlphaG);
            let ccVis = 0.25 / (ccVdotH * ccVdotH + 0.0000001);
            let ccF_d = nme_pbr_ccSchlick(ccF0, ccVdotH);
            let ccTerm = ccF_d * ccD * ccVis * ${NdotLcc};
            ccDirectSpecAcc = ccDirectSpecAcc + v3(ccTerm) * color * atten * ccIntensity * sh;
            baseLayerAtten = 1.0 - ccF_d * ccIntensity;
            ${
                useCcTint
                    ? `let ccLRefract = -refract(L, ${Ncc}, ccIorInv);
            let ccNdotLRefract = clamp(dot(${Ncc}, ccLRefract), 0.0000001, 1.0);
            let ccDirectAbsorption = nme_pbr_cocaLambert(ccAbsorptionColor, ccTintThickness * ((ccNdotLRefract + ccNdotVRefract) / (ccNdotLRefract * ccNdotVRefract)));
            baseLayerAbsorption = mix(v3(1.0), ccDirectAbsorption, v3(ccIntensity));`
                    : ``
            }
        }`;
}

function ccHemiBlock(useClearcoat: boolean, useCcBump: boolean, useCcTint: boolean): string {
    if (!useClearcoat) {
        return "";
    }
    const Ncc = useCcBump ? "ccNormalW" : "N";
    return `
        let ccNdotL_h = clamp(dot(${Ncc}, Ldir), 0.0000001, 1.0);
        if (nl > 0.0) {
            let ccH_h = normalize(V + Ldir);
            let ccNdotH_h = clamp(dot(${Ncc}, ccH_h), 0.0000001, 1.0);
            let ccVdotH_h = saturate(dot(V, ccH_h));
            let ccD_h = nme_pbr_distGGX(ccNdotH_h, ccAlphaG);
            let ccVis_h = 0.25 / (ccVdotH_h * ccVdotH_h + 0.0000001);
            let ccF_h = nme_pbr_ccSchlick(ccF0, ccVdotH_h);
            let ccTerm_h = ccF_h * ccD_h * ccVis_h * ccNdotL_h;
            ccDirectSpecAcc = ccDirectSpecAcc + v3(ccTerm_h) * entry.vLightDiffuse.rgb * ccIntensity * sh;
            baseLayerAtten = 1.0 - ccF_h * ccIntensity;
            ${
                useCcTint
                    ? `let ccLRefract_h = -refract(Ldir, ${Ncc}, ccIorInv);
            let ccNdotLRefract_h = clamp(dot(${Ncc}, ccLRefract_h), 0.0000001, 1.0);
            let ccDirectAbsorption_h = nme_pbr_cocaLambert(ccAbsorptionColor, ccTintThickness * ((ccNdotLRefract_h + ccNdotVRefract) / (ccNdotLRefract_h * ccNdotVRefract)));
            baseLayerAbsorption = mix(v3(1.0), ccDirectAbsorption_h, v3(ccIntensity));`
                    : ``
            }
        }`;
}

function shDirectBlock(useSheen: boolean): string {
    if (!useSheen) {
        return "";
    }
    return `
        if (NdotL > 0.0 && atten > 0.0) {
            let shH = normalize(V + L);
            let shNdotH = clamp(dot(N, shH), 0.0000001, 1.0);
            let shD = nme_pbr_charlieD(shNdotH, shAlphaG);
            let shV = 1.0 / (4.0 * (NdotL + NdotV - NdotL * NdotV) + 0.0000001);
            shDirectAcc = shDirectAcc + shColorScaled * shD * shV * NdotL * color * atten * sh * baseLayerAtten;
        }`;
}

function shHemiBlock(useSheen: boolean): string {
    if (!useSheen) {
        return "";
    }
    return `
        if (nl > 0.0) {
            let shH_h = normalize(V + Ldir);
            let shNdotH_h = clamp(dot(N, shH_h), 0.0000001, 1.0);
            let shD_h = nme_pbr_charlieD(shNdotH_h, shAlphaG);
            let shV_h = 1.0 / (4.0 * (nl + NdotV - nl * NdotV) + 0.0000001);
            shDirectAcc = shDirectAcc + shColorScaled * shD_h * shV_h * nl * entry.vLightSpecular.rgb * sh * baseLayerAtten;
        }`;
}

/** Subsurface IBL block — runs inside the env IBL section. Computes refraction
 *  (refract V through N, sample env at refractionLOD, apply Coca-Lambert tint
 *  absorption + reflectance complement) and translucency (back-scattered SH
 *  irradiance with Burley transmittance). Contributes:
 *    - finalRefraction (vec3, added to lighting)
 *    - refractionOpacity (f32, scales finalIrradiance: 1 - refrIntensity)
 *    - mutates finalIrradiance to include refractionIrradiance + (1-translucency) scale.
 *
 *  Always declares finalRefraction/refractionOpacity even when sub-features are
 *  off so the downstream composition can reference them unconditionally. */
function ssBlock(useSubsurface: boolean, useRefraction: boolean, useAnisotropy: boolean): string {
    if (!useSubsurface && !useRefraction) {
        return `let finalRefraction = v3(0.0);
    let refractionOpacity = 1.0;
    let ssRefractionIrradiance = v3(0.0);`;
    }
    const refrPart = useRefraction
        ? `// Refraction: refract V through N at IOR, sample env at refraction LOD.
    let refrIntensity = clamp(refrIntensityIn, 0.0, 1.0);
    let invIor = 1.0 / max(refrIor, 1.0001);
    let refrV_raw = refract(-V, ${useAnisotropy ? "aniN" : "N"}, invIor);
    let refrV = v3(refrV_raw.x * cosA + refrV_raw.z * sinA, refrV_raw.y, -refrV_raw.x * sinA + refrV_raw.z * cosA);
    let refrAlphaG = mix(alphaG, 0.0, clamp(invIor * 3.0 - 2.0, 0.0, 1.0));
    let refrLod = log2(cubemapDim * refrAlphaG) * sceneU.lodGenerationScale;
    let envRefr = textureSampleLevel(nmeIblTexture, nmeIblSampler, refrV, clamp(refrLod, 0.0, maxLod)).rgb * sceneU.environmentIntensity;
    let volumeAlbedo = nme_pbr_colorAtDistance(ssTintColor, refrTintAtDistance);
    let refrTransmittance = v3(refrIntensity) * nme_pbr_cocaLambert(volumeAlbedo, ssThickness);
    let finalRefractionRaw = envRefr * refrTransmittance * (v3(1.0) - refractionSpecEnvReflectance);
    let refractionOpacity = 1.0 - refrIntensity;`
        : `let finalRefractionRaw = v3(0.0);
    let refractionOpacity = 1.0;`;
    const ssPart = useSubsurface
        ? `// Translucency: back-scattered SH irradiance with Burley transmittance.
    let nN_env = -N_env;
    let backIrradiance = (sceneU.vSphericalL00.xyz
        + sceneU.vSphericalL1_1.xyz * nN_env.y + sceneU.vSphericalL10.xyz * nN_env.z + sceneU.vSphericalL11.xyz * nN_env.x
        + sceneU.vSphericalL2_2.xyz * (nN_env.y * nN_env.x) + sceneU.vSphericalL2_1.xyz * (nN_env.y * nN_env.z)
        + sceneU.vSphericalL20.xyz * (3.0 * nN_env.z * nN_env.z - 1.0) + sceneU.vSphericalL21.xyz * (nN_env.z * nN_env.x)
        + sceneU.vSphericalL22.xyz * (nN_env.x * nN_env.x - nN_env.y * nN_env.y)) * sceneU.environmentIntensity;
    let ssRefractionIrradiance = backIrradiance * ssTransmittance;
    finalIrradiance = finalIrradiance * refractionOpacity;
    finalIrradiance = finalIrradiance * (1.0 - translucencyIntensity);`
        : `let ssRefractionIrradiance = v3(0.0);
    finalIrradiance = finalIrradiance * refractionOpacity;`;
    return `${refrPart}
    ${ssPart}
    let finalRefraction = finalRefractionRaw;`;
}

function HELPER_WGSL(
    useEnv: boolean,
    useClearcoat: boolean,
    useSheen: boolean,
    useRefraction: boolean,
    useSubsurface: boolean,
    useAnisotropy: boolean,
    useShAlbedoScaling: boolean,
    useCcBump: boolean,
    useCcTint: boolean
): string {
    const ccDecls = useClearcoat
        ? `let ccIntensity = clamp(ccIntensityIn, 0.0, 1.0);
    let ccRough = clamp(ccRoughnessIn, 0.0, 1.0);
    let ccAlphaG = ccRough * ccRough + 0.0005;
    let ccF0_raw = (ccIor - 1.0) / (ccIor + 1.0);
    let ccF0 = ccF0_raw * ccF0_raw;
    var ccDirectSpecAcc = v3(0.0);`
        : `let ccDirectSpecAcc = v3(0.0);`;

    const ccNormalSetup = useClearcoat
        ? useCcBump
            ? `// Use the same TBN basis as base PerturbNormal (matches BJS perturbNormal helper).
    let ccNormalW = nme_perturbNormal(worldPos, Ng, ccBumpUv, ccBumpColor, 1.0);
    let ccNdotV = abs(dot(ccNormalW, V)) + 0.0000001;${
        useCcTint
            ? `
    let ccIorInv = 1.0 / max(ccIor, 1.0001);
    let ccAbsorptionColor = nme_pbr_colorAtDistance(max(ccTintColor, v3(0.0000001)), max(ccTintAtDistance, 0.0000001));
    let ccVRefract = refract(-V, ccNormalW, ccIorInv);
    let ccNdotVRefract = abs(dot(ccNormalW, ccVRefract)) + 0.0000001;`
            : ``
    }`
            : `let ccNormalW = N;
    let ccNdotV = NdotV;${
        useCcTint
            ? `
    let ccIorInv = 1.0 / max(ccIor, 1.0001);
    let ccAbsorptionColor = nme_pbr_colorAtDistance(max(ccTintColor, v3(0.0000001)), max(ccTintAtDistance, 0.0000001));
    let ccVRefract = refract(-V, ccNormalW, ccIorInv);
    let ccNdotVRefract = abs(dot(ccNormalW, ccVRefract)) + 0.0000001;`
            : ``
    }`
        : `let ccNormalW = N;
    let ccNdotV: f32 = 0.0;`;

    const shDecls = useSheen
        ? `let shIntensityRaw = clamp(shIntensityIn, 0.0, 1.0);
    ${
        useShAlbedoScaling
            ? `// SHEEN_ALBEDOSCALING ON: don't pre-scale shIntensity (BJS pbrBlockSheen.fx).
    let shIntensity = shIntensityRaw;`
            : `// BJS sheen WITHOUT albedoScaling: shIntensity *= (1 - reflectanceF0)
    let reflectanceF0 = max(colorF0.r, max(colorF0.g, colorF0.b));
    let shIntensity = shIntensityRaw * (1.0 - reflectanceF0);`
    }
    let shRough = clamp(shRoughnessIn, 0.0, 1.0);
    let shAlphaG = shRough * shRough + 0.0005;
    let shColorScaled = shColorIn * shIntensity;
    var shDirectAcc = v3(0.0);`
        : `let shDirectAcc = v3(0.0);`;

    const shIblTerm =
        useEnv && useSheen
            ? `let shSpecLod = log2(cubemapDim * shAlphaG) * sceneU.lodGenerationScale;
    let shEnvRadiance = textureSampleLevel(nmeIblTexture, nmeIblSampler, R, clamp(shSpecLod, 0.0, maxLod)).rgb * sceneU.environmentIntensity;
    let shBrdfBlue = textureSample(nmeBrdfLUT, nmeBrdfSampler, v2(NdotV, shRough)).b;
    let shFinalIbl = shEnvRadiance * shColorScaled * shBrdfBlue * seo * eho;
    ${
        useShAlbedoScaling
            ? `// SHEEN_ALBEDOSCALING: surface albedo and base specular scale by (1 - shInt × max(shColor) × envSheenBrdf.b).
    let shAlbedoScaling = 1.0 - shIntensity * max(max(shColorIn.r, shColorIn.g), shColorIn.b) * shBrdfBlue;`
            : `let shAlbedoScaling: f32 = 1.0;`
    }`
            : `let shFinalIbl = v3(0.0);
    let shAlbedoScaling: f32 = 1.0;`;

    const directSpecR0Decl = useClearcoat
        ? `let _directF0S = sqrt(max(colorF0, v3(0.0)));
    let _directF0T = ((1.0 - ccIor) + (1.0 + ccIor) * _directF0S) / ((1.0 + ccIor) + (1.0 - ccIor) * _directF0S);
    let directSpecR0 = mix(colorF0, clamp(_directF0T * _directF0T, v3(0.0), v3(1.0)), ccIntensity);`
        : `let directSpecR0 = colorF0;`;

    const shIblScale = useClearcoat ? ` * ccConsIBL${useCcTint ? " * ccAbsorption" : ""}` : "";
    const refrCcScale = useClearcoat ? " * ccConsIBL" : "";
    const ccIblPre = useClearcoat
        ? `let ccFresnelIBL = nme_pbr_ccSchlick(ccF0, ccNdotV);
    let ccConsIBL = 1.0 - ccFresnelIBL * ccIntensity;
    let ccBrdfSample = textureSample(nmeBrdfLUT, nmeBrdfSampler, v2(ccNdotV, ccRough)).rgb;
    let ccSpecEnvReflRaw = (v3(ccF0) * ccBrdfSample.y + (v3(1.0) - v3(ccF0)) * ccBrdfSample.x) * ccIntensity;
    let ccEnergyConservation = 1.0 + _coloredR0 * (1.0 / max(ccBrdfSample.y, 0.001) - 1.0);
    let ccEhoT = clamp(1.0 + 1.1 * dot(reflect(-V, ccNormalW), Ng), 0.0, 1.0);
    let ccSpecEnvRefl = ccSpecEnvReflRaw * (ccEhoT * ccEhoT);
    let ccSpecLod = log2(cubemapDim * ccAlphaG) * sceneU.lodGenerationScale;
    let ccR_raw = reflect(-V, ccNormalW);
    let ccR = v3(ccR_raw.x * cosA + ccR_raw.z * sinA, ccR_raw.y, -ccR_raw.x * sinA + ccR_raw.z * cosA);
    let ccEnvRadiance = textureSampleLevel(nmeIblTexture, nmeIblSampler, ccR, clamp(ccSpecLod, 0.0, maxLod)).rgb * sceneU.environmentIntensity;
    ${
        useCcTint
            ? `// Clearcoat absorption: BJS Beer-Lambert path length through the coat.
    let ccAbsorption = mix(v3(1.0), nme_pbr_cocaLambert(ccAbsorptionColor, ccTintThickness * ((ccNdotVRefract + ccNdotVRefract) / (ccNdotVRefract * ccNdotVRefract))), v3(ccIntensity));`
            : `let ccAbsorption = v3(1.0);`
    }
    let ccFinalRadiance = ccEnvRadiance * ccSpecEnvRefl;`
        : ``;
    const ccTintScale = useCcTint ? " * ccAbsorption" : "";
    const ccIblFinal = useClearcoat
        ? `${ccIblPre}
    ${shIblTerm}
    r.lighting = finalIrradiance * shAlbedoScaling * ccConsIBL${ccTintScale}
        + finalRadianceScaled * shAlbedoScaling * ccConsIBL${ccTintScale}
        + ssRefractionIrradiance * ao_c
        + finalSpecularScaledDirect * shAlbedoScaling
        + diffuseAcc * shAlbedoScaling
        + diffuseTransmissionAcc
        + ccDirectSpecAcc * ccEnergyConservation
        + ccFinalRadiance
        + shDirectAcc
        + shFinalIbl${shIblScale}
        + finalRefraction${refrCcScale}${ccTintScale};`
        : `${shIblTerm}
    r.lighting = finalIrradiance * shAlbedoScaling + ssRefractionIrradiance * ao_c + (finalRadianceScaled + finalSpecularScaledDirect + diffuseAcc) * shAlbedoScaling + diffuseTransmissionAcc + shDirectAcc + shFinalIbl + finalRefraction;`;

    const ccDirectFinal = useClearcoat
        ? `r.lighting = diffuseAcc + specAcc + diffuseTransmissionAcc + ccDirectSpecAcc + shDirectAcc;`
        : `r.lighting = diffuseAcc + diffuseTransmissionAcc + specAcc + shDirectAcc;`;

    const refractionSpecEnvReflectanceDecl = useRefraction ? `let refractionSpecEnvReflectance = baseSpecEnvReflectance;` : ``;

    const iblBlock = useEnv
        ? `
    let envRot = sceneU.envRotationY;
    let cosA = cos(envRot); let sinA = sin(envRot);
    let N_specSrc = ${useAnisotropy ? "aniN" : "N"};
    let R_raw = reflect(-V, N_specSrc);
    let R = v3(R_raw.x * cosA + R_raw.z * sinA, R_raw.y, -R_raw.x * sinA + R_raw.z * cosA);
    let N_env = v3(N.x * cosA + N.z * sinA, N.y, -N.x * sinA + N.z * cosA);
    let environmentIrradiance = (sceneU.vSphericalL00.xyz
        + sceneU.vSphericalL1_1.xyz * N_env.y + sceneU.vSphericalL10.xyz * N_env.z + sceneU.vSphericalL11.xyz * N_env.x
        + sceneU.vSphericalL2_2.xyz * (N_env.y * N_env.x) + sceneU.vSphericalL2_1.xyz * (N_env.y * N_env.z)
        + sceneU.vSphericalL20.xyz * (3.0 * N_env.z * N_env.z - 1.0) + sceneU.vSphericalL21.xyz * (N_env.z * N_env.x)
        + sceneU.vSphericalL22.xyz * (N_env.x * N_env.x - N_env.y * N_env.y)) * sceneU.environmentIntensity;
    let brdfSample = textureSample(nmeBrdfLUT, nmeBrdfSampler, v2(NdotV, rough_c));
    let envBrdf = brdfSample.rgb;
    let reflectanceF0Scalar = max(colorF0.r, max(colorF0.g, colorF0.b));
    let baseSpecEnvReflectance = (colorF90 - v3(reflectanceF0Scalar)) * envBrdf.x + v3(reflectanceF0Scalar) * envBrdf.y;
    let seo = clamp((NdotVUnclamped + ao_c) * (NdotVUnclamped + ao_c) - 1.0 + ao_c, 0.0, 1.0);
    let _geoNF = select(-Ng, Ng, dot(Ng, V) > 0.0);
    let _ehoRefl = reflect(-V, N);
    let _ehoT = clamp(1.0 + 1.1 * dot(_ehoRefl, _geoNF), 0.0, 1.0);
    let eho = _ehoT * _ehoT;
    ${
        useClearcoat
            ? `let _cc_t = ccF0_raw;
    let _f0s = sqrt(max(colorF0, v3(0.0)));
    let _f0t = ((1.0 - ccIor) + (1.0 + ccIor) * _f0s) / ((1.0 + ccIor) + (1.0 - ccIor) * _f0s);
    let _f0_remapped = clamp(_f0t * _f0t, v3(0.0), v3(1.0));
    let _coloredR0 = mix(colorF0, _f0_remapped, ccIntensity);`
            : `let _coloredR0 = colorF0;`
    }
    let colorSpecEnvReflectance = ((colorF90 - _coloredR0) * envBrdf.x + _coloredR0 * envBrdf.y) * seo * eho;
    let energyConservation = 1.0 + _coloredR0 * (1.0 / max(envBrdf.y, 0.001) - 1.0);
    let maxLod = f32(textureNumLevels(nmeIblTexture) - 1);
    let cubemapDim = f32(textureDimensions(nmeIblTexture).x);
    let specLod = log2(cubemapDim * alphaG) * sceneU.lodGenerationScale;
    var environmentRadiance = textureSampleLevel(nmeIblTexture, nmeIblSampler, R, clamp(specLod, 0.0, maxLod)).rgb * sceneU.environmentIntensity;
    ${refractionSpecEnvReflectanceDecl}
    var finalIrradiance = environmentIrradiance * surfaceAlbedo;
    let finalRadianceScaled = environmentRadiance * colorSpecEnvReflectance * energyConservation;
    let finalSpecularScaledDirect = specAcc * energyConservation;
    ${ssBlock(useSubsurface, useRefraction, useAnisotropy)}
    finalIrradiance = finalIrradiance * ao_c;
    r.diffuseInd = finalIrradiance;
    r.specularInd = finalRadianceScaled;
    ${ccIblFinal}`
        : `
    r.diffuseInd = v3(0.0);
    r.specularInd = v3(0.0);
    ${ccDirectFinal}`;

    const ccSchlickFn = useClearcoat
        ? `fn nme_pbr_ccSchlick(f0: f32, cosTheta: f32) -> f32 {
    let t = 1.0 - cosTheta;
    let t2 = t * t;
    return f0 + (1.0 - f0) * (t2 * t2 * t);
}
`
        : ``;

    const charlieFn = useSheen
        ? `fn nme_pbr_charlieD(NdotH: f32, alphaG: f32) -> f32 {
    let invR = 1.0 / max(alphaG, 0.0005);
    let cos2h = NdotH * NdotH;
    let sin2h = 1.0 - cos2h;
    return (2.0 + invR) * pow(sin2h, invR * 0.5) / (2.0 * NME_PBR_PI);
}
`
        : ``;

    const anisoFns = useAnisotropy
        ? `fn nme_pbr_anisoRoughness(alphaG: f32, anisotropy: f32) -> v2 {
    let alphaT = max(alphaG * (1.0 + anisotropy), 0.0005);
    let alphaB = max(alphaG * (1.0 - anisotropy), 0.0005);
    return v2(alphaT, alphaB);
}
fn nme_pbr_anisoBentNormal(T: v3, B: v3, N: v3, V: v3, anisotropy: f32) -> v3 {
    var anisotropicFrameDirection = B;
    if (anisotropy < 0.0) {
        anisotropicFrameDirection = T;
    }
    let anisoTan = cross(normalize(anisotropicFrameDirection), V);
    let anisoNormal = cross(anisoTan, anisotropicFrameDirection);
    return normalize(mix(N, anisoNormal, abs(anisotropy)));
}
fn nme_pbr_burleyAnisoD(NdotH: f32, TdotH: f32, BdotH: f32, alphaTB: v2) -> f32 {
    let a2 = alphaTB.x * alphaTB.y;
    let v = v3(alphaTB.y * TdotH, alphaTB.x * BdotH, a2 * NdotH);
    let v2 = dot(v, v);
    let w2 = a2 / max(v2, 0.0000001);
    return a2 * w2 * w2 * (1.0 / NME_PBR_PI);
}
fn nme_pbr_visAnisoSmith(NdotL: f32, NdotV: f32, TdotV: f32, BdotV: f32, TdotL: f32, BdotL: f32, alphaTB: v2) -> f32 {
    let lambdaV = NdotL * length(v3(alphaTB.x * TdotV, alphaTB.y * BdotV, NdotV));
    let lambdaL = NdotV * length(v3(alphaTB.x * TdotL, alphaTB.y * BdotL, NdotL));
    return 0.5 / max(lambdaV + lambdaL, 0.0000001);
}
`
        : ``;

    const ssFns =
        useSubsurface || useRefraction || useCcTint
            ? `fn nme_pbr_transmittanceBurley(tintColor: v3, diffusionDist: v3, thickness: f32) -> v3 {
    let S = v3(1.0) / max(diffusionDist, v3(0.0000001));
    let temp = exp(-0.333333333 * thickness * S);
    return tintColor * 0.25 * (temp * temp * temp + 3.0 * temp);
}
fn nme_pbr_cocaLambert(volumeAlbedo: v3, distance: f32) -> v3 {
    return exp(-volumeAlbedo * distance);
}
fn nme_pbr_colorAtDistance(color: v3, distance: f32) -> v3 {
    return -log(color) / distance;
}
`
            : ``;

    const anisoSetup = useAnisotropy
        ? `// Build TBN from screen-space derivatives (matches BJS cotangent_frame()).
    let _adp1 = dpdx(worldPos);
    let _adp2 = -dpdy(worldPos);
    let _aduv1 = dpdx(anisoUv);
    let _aduv2 = -dpdy(anisoUv);
    let _adp2perp = cross(_adp2, Ng);
    let _adp1perp = cross(Ng, _adp1);
    let _atan = _adp2perp * _aduv1.x + _adp1perp * _aduv2.x;
    let _abit = _adp2perp * _aduv1.y + _adp1perp * _aduv2.y;
    let _adet = max(dot(_atan, _atan), dot(_abit, _abit));
    let _ainvmax = select(0.0, inverseSqrt(_adet), _adet > 0.0);
    let _aTBN0 = normalize(_atan * _ainvmax);
    let _aTBN1 = normalize(_abit * _ainvmax);
    let anisoIntensity = clamp(anisoIntensityIn, -1.0, 1.0);
    let anisoDir = v3(anisoDirection, 0.0);
    let anisoT_raw = _aTBN0 * anisoDir.x + _aTBN1 * anisoDir.y;
    let anisoT = normalize(anisoT_raw);
    let anisoB = normalize(cross(Ng, anisoT));
    let aniAlphaTB = nme_pbr_anisoRoughness(alphaG, anisoIntensity);
    let aniN = nme_pbr_anisoBentNormal(anisoT, anisoB, N, V, anisoIntensity);`
        : `let anisoT = v3(1.0, 0.0, 0.0);
    let anisoB = v3(0.0, 0.0, 1.0);
    let aniAlphaTB = v2(alphaG, alphaG);
    let aniN = N;`;

    return `alias v2 = vec2<f32>;
alias v3 = vec3<f32>;
alias v4 = vec4<f32>;
struct NmePbrMrResult {
    lighting: v3,
    diffuseDir: v3,
    specularDir: v3,
    diffuseInd: v3,
    specularInd: v3,
    shadow: f32,
    lumOverAlpha: f32,
};
const NME_PBR_PI: f32 = 3.14159265358979323846;
fn nme_pbr_distGGX(NdotH: f32, alphaG: f32) -> f32 {
    let a2 = alphaG * alphaG;
    let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
    return a2 / (NME_PBR_PI * d * d);
}
fn nme_pbr_geomGGX(NdotL: f32, NdotV: f32, alphaG: f32) -> f32 {
    let a2 = alphaG * alphaG;
    let gl = NdotL * sqrt(NdotV * (NdotV - a2 * NdotV) + a2);
    let gv = NdotV * sqrt(NdotL * (NdotL - a2 * NdotL) + a2);
    return 0.5 / max(gl + gv, 0.00001);
}
fn nme_pbr_fresSchlick(c: f32, F0: v3, F90: v3) -> v3 {
    let t = 1.0 - c;
    let t2 = t * t;
    return F0 + (F90 - F0) * (t2 * t2 * t);
}
fn nme_pbr_diffuseEON(albedo: v3, sigma: f32, NdotL: f32, NdotV: f32, LdotV: f32) -> v3 {
    return albedo * (1.0 / NME_PBR_PI);
}
${ccSchlickFn}${charlieFn}${anisoFns}${ssFns}fn nme_pbr_mr_compute(
    worldPos: v3, geometricNormal: v3, worldNormal: v3, cameraPos: v3,
    baseColor: v3, metallic: f32, roughness: f32, ao: f32,
    ccIntensityIn: f32, ccRoughnessIn: f32, ccIor: f32,
    ccBumpColor: v3, ccBumpUv: v2,
    ccTintColor: v3, ccTintAtDistance: f32, ccTintThickness: f32,
    shIntensityIn: f32, shColorIn: v3, shRoughnessIn: f32,
    baseIor: f32,
    refrIntensityIn: f32, refrIor: f32, refrTintAtDistance: f32,
    ssTintColor: v3, ssThickness: f32,
    ssTranslucencyIntensityIn: f32, ssDiffusionDist: v3,
    anisoIntensityIn: f32, anisoDirection: v2, anisoUv: v2,
    shadowFactors: v4
) -> NmePbrMrResult {
    var r: NmePbrMrResult;
    let Ng = normalize(geometricNormal);
    let N = normalize(worldNormal);
    let V = normalize(cameraPos - worldPos);
    let NdotVUnclamped = dot(N, V);
    let NdotV = abs(NdotVUnclamped) + 0.0000001;
    let metallic_c = clamp(metallic, 0.0, 1.0);
    let rough_c = clamp(roughness, 0.0, 1.0);
    let alphaG = rough_c * rough_c + 0.0005;
    let dielectricF0Raw = (baseIor - 1.0) / (baseIor + 1.0);
    let dielectricF0Scalar = dielectricF0Raw * dielectricF0Raw;
    let dielectricF0 = v3(dielectricF0Scalar);
    var surfaceAlbedo = baseColor * (1.0 - metallic_c) * (1.0 - dielectricF0Scalar);
    let colorF0 = mix(dielectricF0, baseColor, metallic_c);
    let colorF90 = v3(1.0);
    let ao_c = clamp(ao, 0.0, 1.0);
    let directAlphaG = rough_c * rough_c + 0.0005;
    ${anisoSetup}
    ${ccDecls}
    ${directSpecR0Decl}
    ${ccNormalSetup}
    ${shDecls}
    let translucencyIntensity = ${useSubsurface ? "clamp(ssTranslucencyIntensityIn, 0.0, 1.0)" : "0.0"};
    let ssTransmittance = ${useSubsurface ? "nme_pbr_transmittanceBurley(ssTintColor, ssDiffusionDist, max(ssThickness, 0.0000001)) * translucencyIntensity" : "v3(0.0)"};
    let directDiffuseTranslucencyScale = 1.0 - translucencyIntensity;
    ${
        useRefraction
            ? `// LEGACY_SPECULAR_ENERGY_CONSERVATION is on for BJS NME PBR-MR. When refraction
    let _refractionOpacityPre = 1.0 - clamp(refrIntensityIn, 0.0, 1.0);
    surfaceAlbedo = surfaceAlbedo * _refractionOpacityPre;`
            : ``
    }
    var diffuseAcc = v3(0.0);
    var diffuseTransmissionAcc = v3(0.0);
    var specAcc = v3(0.0);
    var aggShadow: f32 = 0.0;
    var nLights: f32 = 0.0;
    let lc = min(nmeLights.count, ${MAX_LIGHTS}u);
    for (var i: u32 = 0u; i < lc; i = i + 1u) {
        let entry = nmeLights.lights[i];
        let t = u32(entry.vLightData.w);
        let sh = shadowFactors[i];
        if (t == 3u) {
            let Ldir = normalize(entry.vLightData.xyz);
            let nl = clamp(0.5 + 0.5 * dot(N, Ldir), 0.0000001, 1.0);
            let groundSky = mix(entry.vLightDirection.xyz, entry.vLightDiffuse.rgb, nl);
            var baseLayerAtten: f32 = 1.0;
            var baseLayerAbsorption = v3(1.0);${ccHemiBlock(useClearcoat, useCcBump, useCcTint)}
            let H_h = normalize(V + Ldir);
            let NdotH_h = clamp(dot(N, H_h), 0.0000001, 1.0);
            let VdotH_h = saturate(dot(V, H_h));
            let cF_h = nme_pbr_fresSchlick(VdotH_h, directSpecR0, colorF90);
            ${
                useAnisotropy
                    ? `let TdotH_h = dot(anisoT, H_h);
            let BdotH_h = dot(anisoB, H_h);
            let TdotV_h = dot(anisoT, V);
            let BdotV_h = dot(anisoB, V);
            let TdotL_h = dot(anisoT, Ldir);
            let BdotL_h = dot(anisoB, Ldir);
            let D_h = nme_pbr_burleyAnisoD(NdotH_h, TdotH_h, BdotH_h, aniAlphaTB);
            let Vis_h = nme_pbr_visAnisoSmith(nl, NdotV, TdotV_h, BdotV_h, TdotL_h, BdotL_h, aniAlphaTB);
            specAcc = specAcc + cF_h * D_h * Vis_h * nl * entry.vLightDiffuse.rgb * sh * baseLayerAtten * baseLayerAbsorption;`
                    : `let D_h = nme_pbr_distGGX(NdotH_h, directAlphaG);
            let G_h = nme_pbr_geomGGX(nl, NdotV, directAlphaG);
            specAcc = specAcc + cF_h * D_h * G_h * nl * entry.vLightDiffuse.rgb * sh * baseLayerAtten * baseLayerAbsorption;`
            }
            diffuseAcc = diffuseAcc + groundSky * surfaceAlbedo * sh * baseLayerAtten * baseLayerAbsorption;${shHemiBlock(useSheen)}
            aggShadow = aggShadow + sh;
            nLights = nLights + 1.0;
            continue;
        }
        var L: v3;
        var atten: f32 = 1.0;
        let color = entry.vLightDiffuse.rgb;
        if (t == 1u) {
            L = normalize(-entry.vLightData.xyz);
        } else {
            let toL = entry.vLightData.xyz - worldPos;
            let d2 = dot(toL, toL);
            let dist = sqrt(d2);
            L = toL / max(dist, 0.0001);
            let range = entry.vLightDiffuse.a;
            if (t == 2u) {
                let invD2 = 1.0 / max(d2, 0.0000001);
                let cosHalfAngle = entry.vLightDirection.w;
                let kappa = 6.64385618977 / max(1.0 - cosHalfAngle, 0.0001);
                let cd = dot(-entry.vLightDirection.xyz, L);
                let dirFall = exp2(kappa * (cd - 1.0));
                atten = invD2 * dirFall;
            } else {
                atten = 1.0 / max(d2, 0.0000001);
            }
        }
        let NdotLUnclamped = dot(N, L);
        let NdotL = clamp(NdotLUnclamped, 0.0000001, 1.0);
        var baseLayerAtten: f32 = 1.0;
        var baseLayerAbsorption = v3(1.0);${ccDirectBlock(useClearcoat, useCcBump, useCcTint)}
        let _LdotV = select(0.0, dot(L, V), t == 1u);
        let _eonDiffuse = nme_pbr_diffuseEON(surfaceAlbedo, 0.0, NdotL, NdotV, _LdotV);
        diffuseAcc = diffuseAcc + _eonDiffuse * directDiffuseTranslucencyScale * NdotL * color * atten * sh * baseLayerAtten * baseLayerAbsorption;
        if (NdotLUnclamped < 0.0 && translucencyIntensity > 0.0) {
            let _trNdotL = abs(NdotLUnclamped) + 0.0000001;
            let _wrapW = 0.02;
            let _wrapT = 1.0 + _wrapW;
            let _wrapNdotL = clamp((_trNdotL + _wrapW) / (_wrapT * _wrapT), 0.0, 1.0);
            let _clampedAlbT = clamp(surfaceAlbedo, v3(0.1), v3(1.0));
            let _eonTransmit = nme_pbr_diffuseEON(_clampedAlbT, 0.0, max(NdotL, 0.0000001), NdotV, _LdotV) / _clampedAlbT;
            diffuseTransmissionAcc = diffuseTransmissionAcc + _eonTransmit * (ssTransmittance * _wrapNdotL) * color * atten * sh * baseLayerAtten * baseLayerAbsorption;
        }
        if (NdotL > 0.0 && atten > 0.0) {
            let H = normalize(V + L);
            let NdotH = clamp(dot(N, H), 0.0000001, 1.0);
            let VdotH = saturate(dot(V, H));
            let cF = nme_pbr_fresSchlick(VdotH, directSpecR0, colorF90);
            ${
                useAnisotropy
                    ? `let TdotH = dot(anisoT, H);
            let BdotH = dot(anisoB, H);
            let TdotV = dot(anisoT, V);
            let BdotV = dot(anisoB, V);
            let TdotL = dot(anisoT, L);
            let BdotL = dot(anisoB, L);
            let D = nme_pbr_burleyAnisoD(NdotH, TdotH, BdotH, aniAlphaTB);
            let Vis = nme_pbr_visAnisoSmith(NdotL, NdotV, TdotV, BdotV, TdotL, BdotL, aniAlphaTB);
            specAcc = specAcc + cF * D * Vis * NdotL * color * atten * sh * baseLayerAtten * baseLayerAbsorption;`
                    : `let D = nme_pbr_distGGX(NdotH, directAlphaG);
            let G = nme_pbr_geomGGX(NdotL, NdotV, directAlphaG);
            specAcc = specAcc + cF * D * G * NdotL * color * atten * sh * baseLayerAtten * baseLayerAbsorption;`
            }
        }${shDirectBlock(useSheen)}
        aggShadow = aggShadow + sh;
        nLights = nLights + 1.0;
    }
    r.diffuseDir = diffuseAcc;
    r.specularDir = specAcc;
${iblBlock}
    ${
        useEnv
            ? `let _radLum = clamp(dot(finalRadianceScaled * shAlbedoScaling${useClearcoat ? ` * ccConsIBL${ccTintScale}` : ``}, v3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    let _specLum = clamp(dot(finalSpecularScaledDirect * shAlbedoScaling, v3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);${
        useClearcoat
            ? `
    let _ccLum = clamp(dot(ccFinalRadiance, v3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    r.lumOverAlpha = _radLum + _specLum + _ccLum;`
            : `
    r.lumOverAlpha = _radLum + _specLum;`
    }`
            : `let _specLum = clamp(dot(specAcc, v3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    r.lumOverAlpha = _specLum;`
    }
    let lin = max(r.lighting, v3(0.0));
    let gamma = pow(lin, v3(0.45454545));
    r.lighting = clamp(gamma, v3(0.0), v3(1.0));
    if (nLights > 0.0) { r.shadow = aggShadow / nLights; } else { r.shadow = 1.0; }
    return r;
}
`;
}

function resolveOptional(block: NodeBlock, inputName: string, fallback: string, target: "vec3f" | "f32", stage: Stage, state: NodeBuildState, ctx: NodeEmitContext): string {
    const input = block.inputs.get(inputName);
    if (input?.source) {
        return ctx.cast(ctx.resolve(block, inputName, stage, state), target).expr;
    }
    return fallback;
}

export const emitter: BlockEmitter = {
    className: "PBRMetallicRoughnessBlock",
    stage: "fragment",
    emit(block, outputName, stage, state, ctx) {
        const reflectionConnected = !!block.inputs.get("reflection")?.source;
        if (reflectionConnected) {
            state.usesEnv = true;
            ctx.resolve(block, "reflection", stage, state);
        }
        const ccInputRef = block.inputs.get("clearcoat")?.source;
        let ccIntensityExpr = "0.0";
        let ccRoughnessExpr = "0.0";
        let ccIorExpr = "1.5";
        let ccBumpExpr = "v3(0.5, 0.5, 1.0)";
        let ccBumpUvExpr = "v2(0.0)";
        let useCcBump = false;
        let ccTintColorExpr = "v3(1.0)";
        let ccTintAtDistanceExpr = "1.0";
        let ccTintThicknessExpr = "0.0";
        let useCcTint = false;
        let useClearcoat = false;
        if (ccInputRef) {
            const ccBlock = ctx.graph.blocks.get(ccInputRef.blockId);
            if (ccBlock && ccBlock.className === "ClearCoatBlock") {
                useClearcoat = true;
                state.usesClearcoat = true;
                ctx.resolveOutput(ccBlock, ccInputRef.outputName, stage, state);
                ccIntensityExpr = resolveOptional(ccBlock, "intensity", "1.0", "f32", stage, state, ctx);
                ccRoughnessExpr = resolveOptional(ccBlock, "roughness", "0.0", "f32", stage, state, ctx);
                ccIorExpr = resolveOptional(ccBlock, "indexOfRefraction", "1.5", "f32", stage, state, ctx);
                if (ccBlock.inputs.get("normalMapColor")?.source) {
                    useCcBump = true;
                    ccBumpExpr = resolveOptional(ccBlock, "normalMapColor", "v3(0.5, 0.5, 1.0)", "vec3f", stage, state, ctx);
                    const uvIn = ccBlock.inputs.get("uv");
                    if (uvIn?.source) {
                        const e = ctx.resolve(ccBlock, "uv", stage, state);
                        ccBumpUvExpr = e.type === "vec2f" ? e.expr : `(${e.expr}).xy`;
                    }
                }
                if (ccBlock.inputs.get("tintColor")?.source) {
                    useCcTint = true;
                    ccTintColorExpr = resolveOptional(ccBlock, "tintColor", "v3(1.0)", "vec3f", stage, state, ctx);
                    ccTintAtDistanceExpr = resolveOptional(ccBlock, "tintAtDistance", "1.0", "f32", stage, state, ctx);
                    ccTintThicknessExpr = resolveOptional(ccBlock, "tintThickness", "0.0", "f32", stage, state, ctx);
                }
            }
        }
        const shInputRef = block.inputs.get("sheen")?.source;
        let shIntensityExpr = "0.0";
        let shColorExpr = "v3(1.0)";
        let shRoughnessExpr = "0.0";
        let useSheen = false;
        let useShAlbedoScaling = false;
        if (shInputRef) {
            const shBlock = ctx.graph.blocks.get(shInputRef.blockId);
            if (shBlock && shBlock.className === "SheenBlock") {
                useSheen = true;
                state.usesSheen = true;
                useShAlbedoScaling = (shBlock.serialized as { albedoScaling?: boolean }).albedoScaling === true;
                ctx.resolveOutput(shBlock, shInputRef.outputName, stage, state);
                shIntensityExpr = resolveOptional(shBlock, "intensity", "1.0", "f32", stage, state, ctx);
                shColorExpr = resolveOptional(shBlock, "color", "v3(1.0)", "vec3f", stage, state, ctx);
                const shrIn = shBlock.inputs.get("roughness");
                shRoughnessExpr = shrIn?.source
                    ? resolveOptional(shBlock, "roughness", "0.0", "f32", stage, state, ctx)
                    : `clamp(${resolveOptional(block, "roughness", "0.5", "f32", stage, state, ctx)}, 0.0, 1.0)`;
            }
        }
        const ssInputRef = block.inputs.get("subsurface")?.source;
        let useSubsurface = false;
        let useRefraction = false;
        let ssTintColorExpr = "v3(1.0)";
        let ssThicknessExpr = "0.0";
        let ssTranslucencyIntensityExpr = "0.0";
        let ssDiffusionDistExpr = "v3(1.0)";
        let refrIntensityExpr = "0.0";
        let refrIorExpr = resolveOptional(block, "indexOfRefraction", "1.5", "f32", stage, state, ctx);
        let refrTintAtDistanceExpr = "1.0";
        if (ssInputRef) {
            const ssBlk = ctx.graph.blocks.get(ssInputRef.blockId);
            if (ssBlk && ssBlk.className === "SubSurfaceBlock") {
                useSubsurface = true;
                state.usesSubsurface = true;
                ctx.resolveOutput(ssBlk, ssInputRef.outputName, stage, state);
                ssTintColorExpr = resolveOptional(ssBlk, "tintColor", "v3(1.0)", "vec3f", stage, state, ctx);
                ssThicknessExpr = resolveOptional(ssBlk, "thickness", "0.0", "f32", stage, state, ctx);
                ssTranslucencyIntensityExpr = resolveOptional(ssBlk, "translucencyIntensity", "0.0", "f32", stage, state, ctx);
                ssDiffusionDistExpr = resolveOptional(ssBlk, "translucencyDiffusionDist", "v3(1.0)", "vec3f", stage, state, ctx);
                const refrInputRef = ssBlk.inputs.get("refraction")?.source;
                if (refrInputRef) {
                    const refrBlk = ctx.graph.blocks.get(refrInputRef.blockId);
                    if (refrBlk && refrBlk.className === "RefractionBlock") {
                        useRefraction = true;
                        ctx.resolveOutput(refrBlk, refrInputRef.outputName, stage, state);
                        refrIntensityExpr = resolveOptional(refrBlk, "intensity", "1.0", "f32", stage, state, ctx);
                        refrTintAtDistanceExpr = resolveOptional(refrBlk, "tintAtDistance", "1.0", "f32", stage, state, ctx);
                        const volIor = refrBlk.inputs.get("volumeIndexOfRefraction");
                        if (volIor?.source) {
                            refrIorExpr = resolveOptional(refrBlk, "volumeIndexOfRefraction", "1.5", "f32", stage, state, ctx);
                        }
                    }
                }
            }
        }
        const aniInputRef = block.inputs.get("anisotropy")?.source;
        let useAnisotropy = false;
        let anisoIntensityExpr = "0.0";
        let anisoDirectionExpr = "v2(1.0, 0.0)";
        let anisoUvExpr = "v2(0.0)";
        if (aniInputRef) {
            const aniBlk = ctx.graph.blocks.get(aniInputRef.blockId);
            if (aniBlk && aniBlk.className === "AnisotropyBlock") {
                useAnisotropy = true;
                state.usesAnisotropy = true;
                ctx.resolveOutput(aniBlk, aniInputRef.outputName, stage, state);
                anisoIntensityExpr = resolveOptional(aniBlk, "intensity", "0.0", "f32", stage, state, ctx);
                anisoDirectionExpr = resolveOptional(aniBlk, "direction", "v2(1.0, 0.0)", "vec3f", stage, state, ctx);
                const dirIn = aniBlk.inputs.get("direction");
                if (dirIn?.source) {
                    const e = ctx.resolve(aniBlk, "direction", stage, state);
                    anisoDirectionExpr = e.type === "vec2f" ? e.expr : `(${e.expr}).xy`;
                }
                const uvIn = aniBlk.inputs.get("uv");
                if (uvIn?.source) {
                    const e = ctx.resolve(aniBlk, "uv", stage, state);
                    anisoUvExpr = e.type === "vec2f" ? e.expr : `(${e.expr}).xy`;
                }
            }
        }
        const helperKey = `${HELPER_KEY_PREFIX}_${reflectionConnected ? "env" : "noenv"}_${useClearcoat ? "cc" : "nocc"}_${useSheen ? "sh" : "nosh"}_${useRefraction ? "refr" : "norefr"}_${useSubsurface ? "ss" : "noss"}_${useAnisotropy ? "ani" : "noani"}_${useShAlbedoScaling ? "shAS" : "noShAS"}_${useCcBump ? "ccB" : ""}_${useCcTint ? "ccT" : ""}`;
        state.fragment.helpers.set(
            helperKey,
            HELPER_WGSL(reflectionConnected, useClearcoat, useSheen, useRefraction, useSubsurface, useAnisotropy, useShAlbedoScaling, useCcBump, useCcTint)
        );
        state.usesLightsUbo = true;

        const memoKey = `_pbrmr_${block.id}_call`;
        let callVar: string;
        const existing = state.fragment.memo.get(memoKey);
        if (existing) {
            callVar = existing.expr;
        } else {
            const wp = resolveOptional(block, "worldPosition", "v3(0.0)", "vec3f", stage, state, ctx);
            const gn = resolveOptional(block, "worldNormal", "v3(0.0, 1.0, 0.0)", "vec3f", stage, state, ctx);
            const perturbed = block.inputs.get("perturbedNormal");
            const wn = perturbed?.source ? ctx.cast(ctx.resolve(block, "perturbedNormal", stage, state), "vec3f").expr : gn;
            const cp = resolveOptional(block, "cameraPosition", "_NME_CAMERA_POS_", "vec3f", stage, state, ctx);
            const bc = resolveOptional(block, "baseColor", "v3(1.0)", "vec3f", stage, state, ctx);
            const me = resolveOptional(block, "metallic", "0.0", "f32", stage, state, ctx);
            const ro = resolveOptional(block, "roughness", "0.5", "f32", stage, state, ctx);
            const ao = resolveOptional(block, "ambientOcc", "1.0", "f32", stage, state, ctx);
            const baseIorExpr = resolveOptional(block, "indexOfRefraction", "1.5", "f32", stage, state, ctx);
            const sf = state.shadowLights.length > 0 ? `nme_computeShadowFactors(in)` : `v4(1.0)`;
            callVar = `_pbrR${ctx.temp(state, "pbr")}`;
            state.fragment.body.push(
                `let ${callVar} = nme_pbr_mr_compute(${wp}, ${gn}, ${wn}, ${cp}, ${bc}, ${me}, ${ro}, ${ao}, ${ccIntensityExpr}, ${ccRoughnessExpr}, ${ccIorExpr}, ${ccBumpExpr}, ${ccBumpUvExpr}, ${ccTintColorExpr}, ${ccTintAtDistanceExpr}, ${ccTintThicknessExpr}, ${shIntensityExpr}, ${shColorExpr}, ${shRoughnessExpr}, ${baseIorExpr}, ${refrIntensityExpr}, ${refrIorExpr}, ${refrTintAtDistanceExpr}, ${ssTintColorExpr}, ${ssThicknessExpr}, ${ssTranslucencyIntensityExpr}, ${ssDiffusionDistExpr}, ${anisoIntensityExpr}, ${anisoDirectionExpr}, ${anisoUvExpr}, ${sf});`
            );
            state.fragment.memo.set(memoKey, { expr: callVar, type: "vec4f" });
        }

        switch (outputName) {
            case "lighting":
                return { expr: `${callVar}.lighting`, type: "vec3f" };
            case "diffuseDir":
                return { expr: `${callVar}.diffuseDir`, type: "vec3f" };
            case "specularDir":
                return { expr: `${callVar}.specularDir`, type: "vec3f" };
            case "diffuseInd":
                return { expr: `${callVar}.diffuseInd`, type: "vec3f" };
            case "specularInd":
                return { expr: `${callVar}.specularInd`, type: "vec3f" };
            case "shadow":
                return { expr: `${callVar}.shadow`, type: "f32" };
            case "alpha": {
                const cfg = block.serialized as { useSpecularOverAlpha?: boolean; useRadianceOverAlpha?: boolean };
                const useOverAlpha = cfg.useSpecularOverAlpha === true || cfg.useRadianceOverAlpha === true;
                const op = block.inputs.get("opacity");
                const baseAlpha = op?.source ? ctx.cast(ctx.resolve(block, "opacity", stage, state), "f32").expr : "1.0";
                if (useOverAlpha) {
                    return { expr: `clamp(${baseAlpha} + ${callVar}.lumOverAlpha * ${callVar}.lumOverAlpha, 0.0, 1.0)`, type: "f32" };
                }
                return { expr: baseAlpha, type: "f32" };
            }
            case "ambientClr":
            case "clearcoatDir":
            case "clearcoatInd":
            case "sheenDir":
            case "sheenInd":
            case "refraction":
                return { expr: `v3(0.0)`, type: "vec3f" };
            default:
                return { expr: `${callVar}.lighting`, type: "vec3f" };
        }
    },
};
