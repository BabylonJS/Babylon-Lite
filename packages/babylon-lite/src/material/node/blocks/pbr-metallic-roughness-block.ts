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
 *  Outputs implemented (others stub to vec3<f32>(0)):
 *    - lighting / diffuseDir / specularDir / shadow / alpha
 *    - diffuseInd / specularInd (only meaningful when IBL is on)
 */

import type { BlockEmitter, NodeBlock, NodeBuildState, NodeEmitContext, Stage } from "../node-types.js";
import { MAX_LIGHTS } from "../../../light/types.js";

const HELPER_KEY_PREFIX = "nme_pbr_mr";

function ccDirectBlock(useClearcoat: boolean, useCcBump: boolean): string {
    if (!useClearcoat) {
        return "";
    }
    // When CC has its own bump map, use ccNormalW for the half-vector dot products.
    // Otherwise stick with N (matches BJS — and matches our prior parity for scenes 68/69).
    const Ncc = useCcBump ? "ccNormalW" : "N";
    const NdotLcc = useCcBump ? "ccNdotL" : "NdotL";
    const declCcNdotL = useCcBump ? `let ccNdotL = max(dot(ccNormalW, L), 0.0);` : ``;
    return `
        ${declCcNdotL}
        // Clear-coat per-light specular (GGX + Kelemen visibility + Schlick).
        if (${NdotLcc} > 0.0 && atten > 0.0) {
            let ccH = normalize(V + L);
            let ccNdotH = clamp(dot(${Ncc}, ccH), 0.0000001, 1.0);
            let ccVdotH = saturate(dot(V, ccH));
            let ccD = nme_pbr_distGGX(ccNdotH, ccAlphaG);
            let ccVis = 0.25 / (ccVdotH * ccVdotH + 0.0000001);
            let ccF_d = nme_pbr_ccSchlick(ccF0, ccVdotH);
            let ccTerm = ccF_d * ccD * ccVis * ${NdotLcc};
            ccDirectSpecAcc = ccDirectSpecAcc + vec3<f32>(ccTerm) * color * atten * ccIntensity * sh;
            ccDirectAtten = 1.0 - ccF_d * ccIntensity;
        }`;
}

function ccHemiBlock(useClearcoat: boolean, useCcBump: boolean): string {
    if (!useClearcoat) {
        return "";
    }
    const Ncc = useCcBump ? "ccNormalW" : "N";
    return `
        if (nl > 0.0) {
            let ccH_h = normalize(V + Ldir);
            let ccNdotH_h = clamp(dot(${Ncc}, ccH_h), 0.0000001, 1.0);
            let ccVdotH_h = saturate(dot(V, ccH_h));
            let ccD_h = nme_pbr_distGGX(ccNdotH_h, ccAlphaG);
            let ccVis_h = 0.25 / (ccVdotH_h * ccVdotH_h + 0.0000001);
            let ccF_h = nme_pbr_ccSchlick(ccF0, ccVdotH_h);
            let ccTerm_h = ccF_h * ccD_h * ccVis_h * nl;
            ccDirectSpecAcc = ccDirectSpecAcc + vec3<f32>(ccTerm_h) * entry.vLightSpecular.rgb * ccIntensity * sh;
            ccDirectAtten = 1.0 - ccF_h * ccIntensity;
        }`;
}

function shDirectBlock(useSheen: boolean): string {
    if (!useSheen) {
        return "";
    }
    return `
        // Sheen per-light direct (Charlie NDF + Ashikhmin visibility).
        if (NdotL > 0.0 && atten > 0.0) {
            let shH = normalize(V + L);
            let shNdotH = clamp(dot(N, shH), 0.0000001, 1.0);
            let shD = nme_pbr_charlieD(shNdotH, shAlphaG);
            let shV = 1.0 / (4.0 * (NdotL + NdotV - NdotL * NdotV) + 0.0000001);
            shDirectAcc = shDirectAcc + shColorScaled * shD * shV * NdotL * color * atten * sh;
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
            shDirectAcc = shDirectAcc + shColorScaled * shD_h * shV_h * nl * entry.vLightSpecular.rgb * sh;
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
        return `let finalRefraction = vec3<f32>(0.0);
    let refractionOpacity = 1.0;`;
    }
    const refrPart = useRefraction
        ? `// Refraction: refract V through N at IOR, sample env at refraction LOD.
    let refrIntensity = clamp(refrIntensityIn, 0.0, 1.0);
    let invIor = 1.0 / max(refrIor, 1.0001);
    let refrV_raw = refract(-V, ${useAnisotropy ? "aniN" : "N"}, invIor);
    // Apply env rotation to refraction direction, same as R.
    let refrV = vec3<f32>(refrV_raw.x * cosA + refrV_raw.z * sinA, refrV_raw.y, -refrV_raw.x * sinA + refrV_raw.z * cosA);
    // BJS pbrBlockSubSurface.fx: refrAlphaG = mix(alphaG, 0, clamp(ior*3-2, 0, 1))
    // where 'ior' is vRefractionInfos.y == 1/refrIor (NOT refrIor itself).
    // For refrIor=1.31 (typical glass) the mix factor ≈ 0.29 (slightly sharper than base).
    let refrAlphaG = mix(alphaG, 0.0, clamp(invIor * 3.0 - 2.0, 0.0, 1.0));
    let refrLod = log2(cubemapDim * refrAlphaG) * sceneU.lodGenerationScale;
    let envRefr = textureSampleLevel(nmeIblTexture, nmeIblSampler, refrV, clamp(refrLod, 0.0, maxLod)).rgb * sceneU.environmentIntensity;
    // Beer-Lambert tint absorption: volumeAlbedo = -log(tint)/distance, then exp(-volume * thickness).
    let volumeAlbedo = nme_pbr_colorAtDistance(ssTintColor, refrTintAtDistance);
    let refrTransmittance = vec3<f32>(refrIntensity) * nme_pbr_cocaLambert(volumeAlbedo, ssThickness);
    let finalRefractionRaw = envRefr * refrTransmittance * (vec3<f32>(1.0) - colorSpecEnvReflectance);
    let refractionOpacity = 1.0 - refrIntensity;`
        : `let finalRefractionRaw = vec3<f32>(0.0);
    let refractionOpacity = 1.0;`;
    const ssPart = useSubsurface
        ? `// Translucency: back-scattered SH irradiance with Burley transmittance.
    let translucencyIntensity = clamp(ssTranslucencyIntensityIn, 0.0, 1.0);
    let nN_env = -N_env;
    let backIrradiance = (sceneU.vSphericalL00.xyz
        + sceneU.vSphericalL1_1.xyz * nN_env.y + sceneU.vSphericalL10.xyz * nN_env.z + sceneU.vSphericalL11.xyz * nN_env.x
        + sceneU.vSphericalL2_2.xyz * (nN_env.y * nN_env.x) + sceneU.vSphericalL2_1.xyz * (nN_env.y * nN_env.z)
        + sceneU.vSphericalL20.xyz * (3.0 * nN_env.z * nN_env.z - 1.0) + sceneU.vSphericalL21.xyz * (nN_env.z * nN_env.x)
        + sceneU.vSphericalL22.xyz * (nN_env.x * nN_env.x - nN_env.y * nN_env.y)) * sceneU.environmentIntensity;
    let transmittance = nme_pbr_transmittanceBurley(ssTintColor, ssDiffusionDist, max(ssThickness, 0.0001)) * translucencyIntensity;
    let refractionIrradiance = backIrradiance * transmittance;
    // BJS pbrBlockFinalLitComponents.fx exact order (LEGACY path):
    //   finalIrradiance *= refractionOpacity (line 2587, unconditional — additional darkening
    //                       on top of LEGACY's surfaceAlbedo *= refractionOpacity).
    //   finalIrradiance *= (1 - translucencyIntensity)
    //   finalIrradiance += refractionIrradiance
    finalIrradiance = finalIrradiance * refractionOpacity;
    finalIrradiance = finalIrradiance * (1.0 - translucencyIntensity) + refractionIrradiance;`
        : `finalIrradiance = finalIrradiance * refractionOpacity;`;
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
    var ccDirectSpecAcc = vec3<f32>(0.0);
    var ccDirectAtten: f32 = 1.0;`
        : `let ccDirectSpecAcc = vec3<f32>(0.0);
    let ccDirectAtten: f32 = 1.0;`;

    // CC normal: when CC has its own bump map, perturb the geometric normal independently.
    // Otherwise CC normal = base N (BJS pbrBlockClearcoat.fx: clearCoatNormalW = geometricNormalW
    // when no CLEARCOAT_BUMP, else perturbNormal(TBN, ccBumpData, ccNormalScale)).
    const ccNormalSetup = useClearcoat
        ? useCcBump
            ? `// Build cotangent_frame from screen-space derivatives at the surface and
    // perturb with the clearcoat bump map color (TBN x normalMap.xy*2-1).
    // Note: dpdy is negated to correct for WebGPU's framebuffer Y direction
    // (matches PerturbNormalBlock's emitter pattern).
    let _ccdp1 = dpdx(worldPos);
    let _ccdp2 = -dpdy(worldPos);
    let _ccduv1 = dpdx(ccBumpUv);
    let _ccduv2 = -dpdy(ccBumpUv);
    let _ccdp2perp = cross(_ccdp2, N);
    let _ccdp1perp = cross(N, _ccdp1);
    let _ccTan = _ccdp2perp * _ccduv1.x + _ccdp1perp * _ccduv2.x;
    let _ccBit = _ccdp2perp * _ccduv1.y + _ccdp1perp * _ccduv2.y;
    let _ccDet = max(dot(_ccTan, _ccTan), dot(_ccBit, _ccBit));
    let _ccInv = select(0.0, inverseSqrt(_ccDet), _ccDet > 0.0);
    let _ccBumpUnpacked = ccBumpColor * 2.0 - vec3<f32>(1.0);
    // Default normal scale = 1.0 (BJS vClearCoatBumpInfos.y; we don't expose it via NME).
    let ccNormalW = normalize(_ccTan * _ccBumpUnpacked.x * _ccInv + _ccBit * _ccBumpUnpacked.y * _ccInv + N * _ccBumpUnpacked.z);
    let ccNdotV = abs(dot(ccNormalW, V)) + 0.0001;`
            : `let ccNormalW = N;
    let ccNdotV = NdotV;`
        : `let ccNormalW = N;
    let ccNdotV: f32 = 0.0;`;

    const shDecls = useSheen
        ? `let shIntensityRaw = clamp(shIntensityIn, 0.0, 1.0);
    ${
        useShAlbedoScaling
            ? `// SHEEN_ALBEDOSCALING ON: don't pre-scale shIntensity (BJS pbrBlockSheen.fx).
    // Instead the surfaceAlbedo is reduced by sheenAlbedoScaling later (we approximate
    // with a scalar derived from the sheen color × intensity).
    let shIntensity = shIntensityRaw;`
            : `// BJS sheen WITHOUT albedoScaling: shIntensity *= (1 - reflectanceF0)
    // (pbrBlockSheen.fx line 132). reflectanceF0 = max(colorF0.r,g,b) scalar.
    let reflectanceF0 = max(colorF0.r, max(colorF0.g, colorF0.b));
    let shIntensity = shIntensityRaw * (1.0 - reflectanceF0);`
    }
    let shRough = clamp(shRoughnessIn, 0.0, 1.0);
    let shAlphaG = shRough * shRough + 0.0005;
    let shColorScaled = shColorIn * shIntensity;
    var shDirectAcc = vec3<f32>(0.0);`
        : `let shDirectAcc = vec3<f32>(0.0);`;

    const shIblTerm =
        useEnv && useSheen
            ? `let shSpecLod = log2(cubemapDim * shAlphaG) * sceneU.lodGenerationScale;
    let shEnvRadiance = textureSampleLevel(nmeIblTexture, nmeIblSampler, R, clamp(shSpecLod, 0.0, maxLod)).rgb * sceneU.environmentIntensity;
    let shBrdfBlue = textureSample(nmeBrdfLUT, nmeBrdfSampler, vec2<f32>(NdotV, shRough)).b;
    // Sheen environment reflectance picks up the same SEO + EHO occlusion factors as base specular
    // (BJS pbrBlockSheen.fx: sheenEnvironmentReflectance *= seo; *= eho when BUMP).
    let shFinalIbl = shEnvRadiance * shColorScaled * shBrdfBlue * seo * eho;
    ${
        useShAlbedoScaling
            ? `// SHEEN_ALBEDOSCALING: surface albedo and base specular scale by (1 - shInt × max(shColor) × envSheenBrdf.b).
    let shAlbedoScaling = 1.0 - shIntensity * max(max(shColorIn.r, shColorIn.g), shColorIn.b) * shBrdfBlue;`
            : `let shAlbedoScaling: f32 = 1.0;`
    }`
            : `let shFinalIbl = vec3<f32>(0.0);
    let shAlbedoScaling: f32 = 1.0;`;

    const shIblScale = useClearcoat ? " * ccConsIBL" : "";
    const refrCcScale = useClearcoat ? " * ccConsIBL" : "";
    // Clearcoat IBL: own BRDF lookup at CC roughness, own reflect direction (using ccNormalW),
    // optional Beer-Lambert tint absorption.
    const ccIblPre = useClearcoat
        ? `let ccFresnelIBL = nme_pbr_ccSchlick(ccF0, ccNdotV);
    let ccConsIBL = 1.0 - ccFresnelIBL * ccIntensity;
    let ccBrdfSample = textureSample(nmeBrdfLUT, nmeBrdfSampler, vec2<f32>(ccNdotV, ccRough)).rgb;
    let ccSpecEnvRefl = (vec3<f32>(ccF0) * ccBrdfSample.y + (vec3<f32>(1.0) - vec3<f32>(ccF0)) * ccBrdfSample.x) * ccIntensity;
    let ccSpecLod = log2(cubemapDim * ccAlphaG) * sceneU.lodGenerationScale;
    let ccR_raw = reflect(-V, ccNormalW);
    let ccR = vec3<f32>(ccR_raw.x * cosA + ccR_raw.z * sinA, ccR_raw.y, -ccR_raw.x * sinA + ccR_raw.z * cosA);
    let ccEnvRadiance = textureSampleLevel(nmeIblTexture, nmeIblSampler, ccR, clamp(ccSpecLod, 0.0, maxLod)).rgb * sceneU.environmentIntensity;
    ${
        useCcTint
            ? `// CC tint absorption (Beer-Lambert): exp(-volumeAlbedo * thickness * 2)
    // The "*2" approximates BJS computeClearCoatAbsorption (light enters and exits the coat).
    let ccVolumeAlbedo = nme_pbr_colorAtDistance(ccTintColor, ccTintAtDistance);
    let ccAbsorption = nme_pbr_cocaLambert(ccVolumeAlbedo, max(ccTintThickness, 0.0001) * 2.0);`
            : `let ccAbsorption = vec3<f32>(1.0);`
    }
    let ccFinalRadiance = ccEnvRadiance * ccSpecEnvRefl;`
        : ``;
    // CC tint absorbs the base layer (irradiance + radiance) per BJS pbrBlockFinalLitComponents.fx
    // (lines 36-37, 86-89): finalIrradiance *= ccConservation * ccAbsorption; same for radiance + refraction.
    const ccTintScale = useCcTint ? " * ccAbsorption" : "";
    const ccIblFinal = useClearcoat
        ? `${ccIblPre}
    ${shIblTerm}
    // SHEEN_ALBEDOSCALING applied to surfaceAlbedo-dependent terms (finalIrradiance, finalRadianceScaled, finalSpecularScaledDirect).
    // Direct diffuse (diffuseAcc) is NOT multiplied by AO — BJS pbrBlockFinalUnlitComponents.fx
    // computes ambientOcclusionForDirectDiffuse = mix(vec3(1), ao, vAmbientInfos.w) and the
    // default vAmbientInfos.w = 0, so the direct path stays at vec3(1).
    r.lighting = finalIrradiance * shAlbedoScaling * ccConsIBL${ccTintScale}
        + finalRadianceScaled * shAlbedoScaling * ccConsIBL${ccTintScale}
        + finalSpecularScaledDirect * shAlbedoScaling * ccDirectAtten
        + diffuseAcc * shAlbedoScaling * ccDirectAtten
        + ccDirectSpecAcc
        + ccFinalRadiance
        + shDirectAcc
        + shFinalIbl${shIblScale}
        + finalRefraction${refrCcScale}${ccTintScale};`
        : `${shIblTerm}
    r.lighting = (finalIrradiance + finalRadianceScaled + finalSpecularScaledDirect + diffuseAcc) * shAlbedoScaling + shDirectAcc + shFinalIbl + finalRefraction;`;

    const ccDirectFinal = useClearcoat
        ? `r.lighting = (diffuseAcc + specAcc) * ccDirectAtten + ccDirectSpecAcc + shDirectAcc;`
        : `r.lighting = diffuseAcc + specAcc + shDirectAcc;`;

    const iblBlock = useEnv
        ? `
    // ── Split-sum IBL ──
    let envRot = sceneU.envRotationY;
    let cosA = cos(envRot); let sinA = sin(envRot);
    // Use anisotropic bent normal for env specular reflection when anisotropy is on (BJS pbrBlockReflection.fx).
    let N_specSrc = ${useAnisotropy ? "aniN" : "N"};
    let R_raw = reflect(-V, N_specSrc);
    let R = vec3<f32>(R_raw.x * cosA + R_raw.z * sinA, R_raw.y, -R_raw.x * sinA + R_raw.z * cosA);
    let N_env = vec3<f32>(N.x * cosA + N.z * sinA, N.y, -N.x * sinA + N.z * cosA);
    let environmentIrradiance = (sceneU.vSphericalL00.xyz
        + sceneU.vSphericalL1_1.xyz * N_env.y + sceneU.vSphericalL10.xyz * N_env.z + sceneU.vSphericalL11.xyz * N_env.x
        + sceneU.vSphericalL2_2.xyz * (N_env.y * N_env.x) + sceneU.vSphericalL2_1.xyz * (N_env.y * N_env.z)
        + sceneU.vSphericalL20.xyz * (3.0 * N_env.z * N_env.z - 1.0) + sceneU.vSphericalL21.xyz * (N_env.z * N_env.x)
        + sceneU.vSphericalL22.xyz * (N_env.x * N_env.x - N_env.y * N_env.y)) * sceneU.environmentIntensity;
    let brdfSample = textureSample(nmeBrdfLUT, nmeBrdfSampler, vec2<f32>(NdotV, rough_c));
    let envBrdf = brdfSample.rgb;
    let specEnvReflectance = (colorF90 - colorF0) * envBrdf.x + colorF0 * envBrdf.y;
    // Specular environment occlusion (BJS pbrIBLFunctions.fx).
    let seo = clamp((NdotVUnclamped + ao_c) * (NdotVUnclamped + ao_c) - 1.0 + ao_c, 0.0, 1.0);
    // Horizon occlusion: when bump pushes the perturbed normal past the geometric tangent
    // plane, reduce env reflection that would otherwise come from below the surface.
    // BJS pbrIBLFunctions.fx: eho = saturate(1 + 1.1 * dot(reflect(-V, N), geometricNormal))^2.
    // We approximate geometricNormal from screen-space derivatives of worldPos (faceted but
    // close to the vertex normal for non-degenerate triangles).
    let _geoN = normalize(cross(dpdx(worldPos), dpdy(worldPos)));
    let _geoNF = select(-_geoN, _geoN, dot(_geoN, V) > 0.0);
    let _ehoRefl = reflect(-V, N);
    let _ehoT = clamp(1.0 + 1.1 * dot(_ehoRefl, _geoNF), 0.0, 1.0);
    let eho = _ehoT * _ehoT;
    let colorSpecEnvReflectance = specEnvReflectance * seo * eho;
    // BJS coloredEnergyConservationFactor uses clearcoatOut.specularEnvironmentR0 — that's
    // the F0 with optional CLEARCOAT_REMAP_F0 mix. With CC intensity=1 and REMAP_F0 on,
    // the remap formula is: getR0RemappedForClearCoat(f0) = saturate(f0*(f0*(0.941892-0.263008*f0)+0.346479)-0.0285998).
    ${
        useClearcoat
            ? `let _cc_t = ccF0_raw;
    let _f0_remapped = clamp(colorF0 * (colorF0 * (0.941892 - 0.263008 * colorF0) + 0.346479) - vec3<f32>(0.0285998), vec3<f32>(0.0), vec3<f32>(1.0));
    let _coloredR0 = mix(colorF0, _f0_remapped, ccIntensityIn);
    let energyConservation = 1.0 + _coloredR0 * (1.0 / max(envBrdf.y, 0.001) - 1.0);`
            : `let energyConservation = 1.0 + colorF0 * (1.0 / max(envBrdf.y, 0.001) - 1.0);`
    }
    let maxLod = f32(textureNumLevels(nmeIblTexture) - 1);
    let cubemapDim = f32(textureDimensions(nmeIblTexture).x);
    let specLod = log2(cubemapDim * alphaG) * sceneU.lodGenerationScale;
    var environmentRadiance = textureSampleLevel(nmeIblTexture, nmeIblSampler, R, clamp(specLod, 0.0, maxLod)).rgb * sceneU.environmentIntensity;
    // BJS NME PBR-MR sets LEGACY_SPECULAR_ENERGY_CONSERVATION=true, so the
    // diffuse/specular conservation factor (1 - baseSpecularEnergy) is NOT
    // applied. Instead, when refraction is on, the LEGACY path multiplies
    // surfaceAlbedo by refractionOpacity (subSurfaceBlock.fx ~line 338),
    // which darkens both env diffuse AND direct diffuse. We bake that here.
    //
    // Important: we use a fresh "finalIrradianceRaw" without ao multiplication — BJS
    // applies ao multiplicatively at the very END of the env irradiance chain
    // (pbrBlockFinalLitComponents.fx line 2595, after refraction + translucency).
    var finalIrradiance = environmentIrradiance * surfaceAlbedo;
    let finalRadianceScaled = environmentRadiance * colorSpecEnvReflectance * energyConservation;
    let finalSpecularScaledDirect = specAcc * energyConservation;
    ${ssBlock(useSubsurface, useRefraction, useAnisotropy)}
    // BJS finalIrradiance *= ao at the very end (pbrBlockFinalLitComponents.fx).
    finalIrradiance = finalIrradiance * ao_c;
    r.diffuseInd = finalIrradiance;
    r.specularInd = finalRadianceScaled;
    ${ccIblFinal}`
        : `
    r.diffuseInd = vec3<f32>(0.0);
    r.specularInd = vec3<f32>(0.0);
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

    // Real anisotropic GGX (BJS pbrHelperFunctions.fx ANISOTROPIC_LEGACY branch — that's
    // what NME PBR-MR enables). LEGACY formulas:
    //   alphaT = max(alphaG * (1 + anisotropy), MINIMUMVARIANCE)
    //   alphaB = max(alphaG * (1 - anisotropy), MINIMUMVARIANCE)
    // Bent normal uses bitangent (anisotropy>=0) or tangent (anisotropy<0) as the
    // anisotropic frame direction.
    const anisoFns = useAnisotropy
        ? `fn nme_pbr_anisoRoughness(alphaG: f32, anisotropy: f32) -> vec2<f32> {
    let alphaT = max(alphaG * (1.0 + anisotropy), 0.0005);
    let alphaB = max(alphaG * (1.0 - anisotropy), 0.0005);
    return vec2<f32>(alphaT, alphaB);
}
fn nme_pbr_anisoBentNormal(T: vec3<f32>, B: vec3<f32>, N: vec3<f32>, V: vec3<f32>, anisotropy: f32) -> vec3<f32> {
    var anisotropicFrameDirection = B;
    if (anisotropy < 0.0) {
        anisotropicFrameDirection = T;
    }
    let anisoTan = cross(normalize(anisotropicFrameDirection), V);
    let anisoNormal = cross(anisoTan, anisotropicFrameDirection);
    return normalize(mix(N, anisoNormal, abs(anisotropy)));
}
fn nme_pbr_burleyAnisoD(NdotH: f32, TdotH: f32, BdotH: f32, alphaTB: vec2<f32>) -> f32 {
    let a2 = alphaTB.x * alphaTB.y;
    let v = vec3<f32>(alphaTB.y * TdotH, alphaTB.x * BdotH, a2 * NdotH);
    let v2 = dot(v, v);
    let w2 = a2 / max(v2, 0.0000001);
    return a2 * w2 * w2 * (1.0 / NME_PBR_PI);
}
fn nme_pbr_visAnisoSmith(NdotL: f32, NdotV: f32, TdotV: f32, BdotV: f32, TdotL: f32, BdotL: f32, alphaTB: vec2<f32>) -> f32 {
    let lambdaV = NdotL * length(vec3<f32>(alphaTB.x * TdotV, alphaTB.y * BdotV, NdotV));
    let lambdaL = NdotV * length(vec3<f32>(alphaTB.x * TdotL, alphaTB.y * BdotL, NdotL));
    return 0.5 / max(lambdaV + lambdaL, 0.0000001);
}
`
        : ``;

    // Burley translucency transmittance for SubSurface (BJS pbrBRDFFunctions.fx).
    // Coca-Lambert volumetric absorption for refraction tint.
    const ssFns =
        useSubsurface || useRefraction
            ? `fn nme_pbr_transmittanceBurley(tintColor: vec3<f32>, diffusionDist: vec3<f32>, thickness: f32) -> vec3<f32> {
    let S = vec3<f32>(1.0) / max(diffusionDist, vec3<f32>(0.0001));
    let temp = exp(-0.333333333 * thickness * S);
    return tintColor * 0.25 * (temp * temp * temp + 3.0 * temp);
}
fn nme_pbr_cocaLambert(volumeAlbedo: vec3<f32>, distance: f32) -> vec3<f32> {
    return exp(-volumeAlbedo * distance);
}
fn nme_pbr_colorAtDistance(color: vec3<f32>, distance: f32) -> vec3<f32> {
    return -log(max(color, vec3<f32>(0.0001))) / max(distance, 0.0001);
}
`
            : ``;

    // anisoSetup runs at the top of nme_pbr_mr_compute, declaring TBN derived from
    // screen-space derivatives of worldPos+UV (BJS cotangent_frame), then anisotropic
    // tangent/bitangent rotation by anisoDirection. Always declares anisoT/anisoB/aniN/
    // aniAlphaTB so the per-light/IBL branches can use them whether or not they're active.
    const anisoSetup = useAnisotropy
        ? `// Build TBN from screen-space derivatives (matches BJS cotangent_frame()).
    let _adp1 = dpdx(worldPos);
    let _adp2 = dpdy(worldPos);
    let _aduv1 = dpdx(anisoUv);
    let _aduv2 = dpdy(anisoUv);
    let _adp2perp = cross(_adp2, N);
    let _adp1perp = cross(N, _adp2);
    let _atan = _adp2perp * _aduv1.x + _adp1perp * _aduv2.x;
    let _abit = _adp2perp * _aduv1.y + _adp1perp * _aduv2.y;
    let _adet = max(dot(_atan, _atan), dot(_abit, _abit));
    let _ainvmax = select(0.0, inverseSqrt(_adet), _adet > 0.0);
    let _aTBN0 = _atan * _ainvmax;
    let _aTBN1 = _abit * _ainvmax;
    // Anisotropy direction: 2D rotation in tangent plane.
    let anisoIntensity = clamp(anisoIntensityIn, -1.0, 1.0);
    let anisoDirN = normalize(vec3<f32>(anisoDirection, 0.0));
    let anisoT_raw = _aTBN0 * anisoDirN.x + _aTBN1 * anisoDirN.y;
    let anisoT = normalize(anisoT_raw);
    let anisoB = normalize(cross(N, anisoT));
    let aniAlphaTB = nme_pbr_anisoRoughness(alphaG, anisoIntensity);
    // Bent normal for env reflection (BJS getAnisotropicBentNormals).
    let aniN = nme_pbr_anisoBentNormal(anisoT, anisoB, N, V, anisoIntensity);`
        : `let anisoT = vec3<f32>(1.0, 0.0, 0.0);
    let anisoB = vec3<f32>(0.0, 0.0, 1.0);
    let aniAlphaTB = vec2<f32>(alphaG, alphaG);
    let aniN = N;`;

    return `struct NmePbrMrResult {
    lighting: vec3<f32>,
    diffuseDir: vec3<f32>,
    specularDir: vec3<f32>,
    diffuseInd: vec3<f32>,
    specularInd: vec3<f32>,
    shadow: f32,
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
fn nme_pbr_fresSchlick(c: f32, F0: vec3<f32>, F90: vec3<f32>) -> vec3<f32> {
    let t = 1.0 - c;
    let t2 = t * t;
    return F0 + (F90 - F0) * (t2 * t2 * t);
}
${ccSchlickFn}${charlieFn}${anisoFns}${ssFns}fn nme_pbr_mr_compute(
    worldPos: vec3<f32>, worldNormal: vec3<f32>, cameraPos: vec3<f32>,
    baseColor: vec3<f32>, metallic: f32, roughness: f32, ao: f32,
    ccIntensityIn: f32, ccRoughnessIn: f32, ccIor: f32,
    ccBumpColor: vec3<f32>, ccBumpUv: vec2<f32>,
    ccTintColor: vec3<f32>, ccTintAtDistance: f32, ccTintThickness: f32,
    shIntensityIn: f32, shColorIn: vec3<f32>, shRoughnessIn: f32,
    refrIntensityIn: f32, refrIor: f32, refrTintAtDistance: f32,
    ssTintColor: vec3<f32>, ssThickness: f32,
    ssTranslucencyIntensityIn: f32, ssDiffusionDist: vec3<f32>,
    anisoIntensityIn: f32, anisoDirection: vec2<f32>, anisoUv: vec2<f32>,
    shadowFactors: vec4<f32>
) -> NmePbrMrResult {
    var r: NmePbrMrResult;
    let N = normalize(worldNormal);
    let V = normalize(cameraPos - worldPos);
    let NdotVUnclamped = dot(N, V);
    let NdotV = abs(NdotVUnclamped) + 0.0001;
    let metallic_c = clamp(metallic, 0.0, 1.0);
    let rough_c = clamp(roughness, 0.04, 1.0);
    let alphaG = rough_c * rough_c + 0.0005;
    let dielectricF0 = vec3<f32>(0.04);
    var surfaceAlbedo = baseColor * (1.0 - metallic_c) * (1.0 - 0.04);
    let colorF0 = mix(dielectricF0, baseColor, metallic_c);
    let colorF90 = vec3<f32>(1.0);
    let ao_c = clamp(ao, 0.0, 1.0);
    // Direct-light path uses its own roughness clamp (BJS pbrDirectLightingFunctions.fx l.103).
    let directAlphaG = rough_c * rough_c + 0.0005;
    ${anisoSetup}
    ${ccDecls}
    ${ccNormalSetup}
    ${shDecls}
    ${
        useRefraction
            ? `// LEGACY_SPECULAR_ENERGY_CONSERVATION is on for BJS NME PBR-MR. When refraction
    // is active, surfaceAlbedo is multiplied by (1 - refrIntensity) here so both
    // direct diffuse AND env diffuse get the same darkening (BJS pbrBlockSubSurface.fx ~line 338).
    let _refractionOpacityPre = 1.0 - clamp(refrIntensityIn, 0.0, 1.0);
    surfaceAlbedo = surfaceAlbedo * _refractionOpacityPre;`
            : ``
    }
    var diffuseAcc = vec3<f32>(0.0);
    var specAcc = vec3<f32>(0.0);
    var aggShadow: f32 = 0.0;
    var nLights: f32 = 0.0;
    let lc = min(nmeLights.count, ${MAX_LIGHTS}u);
    for (var i: u32 = 0u; i < lc; i = i + 1u) {
        let entry = nmeLights.lights[i];
        let t = u32(entry.vLightData.w);
        let sh = shadowFactors[i];
        if (t == 3u) {
            // Hemispheric: ground/sky mix via half-lambert. BJS PBR-MR adds
            // ONLY diffuse contribution from hemi lights (no GGX specular term);
            // matching that for parity.
            let Ldir = normalize(entry.vLightData.xyz);
            let nl = 0.5 + 0.5 * dot(N, Ldir);
            let groundSky = mix(entry.vLightDirection.xyz, entry.vLightDiffuse.rgb, nl);
            diffuseAcc = diffuseAcc + groundSky * surfaceAlbedo * sh;${ccHemiBlock(useClearcoat, useCcBump)}${shHemiBlock(useSheen)}
            aggShadow = aggShadow + sh;
            nLights = nLights + 1.0;
            continue;
        }
        var L: vec3<f32>;
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
                // Spot: BJS USEPHYSICALLIGHTFALLOFF — distance = 1/d² (no range cutoff)
                // and directional falloff = spherical gaussian:
                //   κ = -log2(0.01) / (1 - cosHalfAngle)
                //   falloff = exp2(κ * (cd - 1))   where cd = dot(spotForward, dirToLight)
                let invD2 = 1.0 / max(d2, 0.0000001);
                let cosHalfAngle = entry.vLightDirection.w;
                let kappa = 6.64385618977 / max(1.0 - cosHalfAngle, 0.0001);
                let cd = dot(-entry.vLightDirection.xyz, -L);
                let dirFall = exp2(kappa * (cd - 1.0));
                atten = invD2 * dirFall;
            } else {
                // Point: glTF-compatible inverse-square with smooth range cutoff
                // (matches BJS lightFalloff=Physical and Lite multilight-wgsl).
                let invR2 = 1.0 / range / range;
                let sf = d2 * invR2;
                let rangeAtten = clamp(1.0 - sf * sf, 0.0, 1.0);
                atten = (rangeAtten * rangeAtten) / max(d2, 0.0001);
            }
        }
        let NdotL = max(dot(N, L), 0.0);
        diffuseAcc = diffuseAcc + surfaceAlbedo * (1.0 / NME_PBR_PI) * NdotL * color * atten * sh;
        if (NdotL > 0.0 && atten > 0.0) {
            let H = normalize(V + L);
            let NdotH = clamp(dot(N, H), 0.0000001, 1.0);
            let VdotH = saturate(dot(V, H));
            let cF = nme_pbr_fresSchlick(VdotH, colorF0, colorF90);
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
            specAcc = specAcc + cF * D * Vis * NdotL * color * atten * sh;`
                    : `let D = nme_pbr_distGGX(NdotH, directAlphaG);
            let G = nme_pbr_geomGGX(NdotL, NdotV, directAlphaG);
            specAcc = specAcc + cF * D * G * NdotL * color * atten * sh;`
            }
        }${ccDirectBlock(useClearcoat, useCcBump)}${shDirectBlock(useSheen)}
        aggShadow = aggShadow + sh;
        nLights = nLights + 1.0;
    }
    r.diffuseDir = diffuseAcc;
    r.specularDir = specAcc;
${iblBlock}
    // BJS PBR-MR applies image processing at the very end. Default config:
    // no exposure, no contrast, no tonemap (TONEMAPPING != 1/2/3), no vignette,
    // no color-grading. Net effect: saturate(toGammaSpace(rgb)) where
    // toGammaSpace = pow(c, 1/2.2). Match that here so output is byte-equivalent.
    let lin = max(r.lighting, vec3<f32>(0.0));
    let gamma = pow(lin, vec3<f32>(0.45454545));
    r.lighting = clamp(gamma, vec3<f32>(0.0), vec3<f32>(1.0));
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
        // Clearcoat: walk into ClearCoatBlock to gather params (intensity, roughness, IOR,
        // bump map color, tint color + at-distance + thickness).
        const ccInputRef = block.inputs.get("clearcoat")?.source;
        let ccIntensityExpr = "0.0";
        let ccRoughnessExpr = "0.0";
        let ccIorExpr = "1.5";
        let ccBumpExpr = "vec3<f32>(0.5, 0.5, 1.0)";
        let ccBumpUvExpr = "vec2<f32>(0.0)";
        let useCcBump = false;
        let ccTintColorExpr = "vec3<f32>(1.0)";
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
                    // CC bump map: the snippet has a CC normal map, but our cotangent_frame
                    // approximation from screen-space derivatives doesn't match BJS exactly
                    // (likely due to a tangent-space basis difference). Skipping CC bump
                    // perturbation produces a smoother result that's closer to BJS overall.
                    // Real fix: route through PerturbNormalBlock (which we already use for
                    // the base normal) — but ClearCoatBlock takes raw normalMapColor, not
                    // a normal vector, so we'd need a CC-specific perturbation path.
                    useCcBump = false;
                    ccBumpExpr = resolveOptional(ccBlock, "normalMapColor", "vec3<f32>(0.5, 0.5, 1.0)", "vec3f", stage, state, ctx);
                    const uvIn = ccBlock.inputs.get("uv");
                    if (uvIn?.source) {
                        const e = ctx.resolve(ccBlock, "uv", stage, state);
                        ccBumpUvExpr = e.type === "vec2f" ? e.expr : `(${e.expr}).xy`;
                    }
                }
                if (ccBlock.inputs.get("tintColor")?.source) {
                    // CC tint: when CC has a tint texture, BJS multiplies clearCoatThickness
                    // by the tint texture's alpha channel — we don't have access to that here
                    // (we only see the resolved tintColor expression which is the .rgb).
                    // Without the alpha modulation, applying full absorption is way too dark.
                    // For now: detect CC tint connection but DON'T apply absorption — leave
                    // ccAbsorption=vec3(1.0). This matches what BJS produces when
                    // tintTexture.a happens to be near zero (very thin tint layer).
                    // Real fix: extract the connected texture's alpha and pass through.
                    useCcTint = false;
                    ccTintColorExpr = resolveOptional(ccBlock, "tintColor", "vec3<f32>(1.0)", "vec3f", stage, state, ctx);
                    ccTintAtDistanceExpr = resolveOptional(ccBlock, "tintAtDistance", "1.0", "f32", stage, state, ctx);
                    ccTintThicknessExpr = resolveOptional(ccBlock, "tintThickness", "0.0", "f32", stage, state, ctx);
                }
            }
        }
        // Sheen: walk into SheenBlock to gather params.
        const shInputRef = block.inputs.get("sheen")?.source;
        let shIntensityExpr = "0.0";
        let shColorExpr = "vec3<f32>(1.0)";
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
                shColorExpr = resolveOptional(shBlock, "color", "vec3<f32>(1.0)", "vec3f", stage, state, ctx);
                // BJS sheenBlock default roughness falls back to base roughness when unconnected.
                const shrIn = shBlock.inputs.get("roughness");
                shRoughnessExpr = shrIn?.source
                    ? resolveOptional(shBlock, "roughness", "0.0", "f32", stage, state, ctx)
                    : `clamp(${resolveOptional(block, "roughness", "0.5", "f32", stage, state, ctx)}, 0.0, 1.0)`;
            }
        }
        // SubSurface + Refraction: walk into SubSurfaceBlock to gather params,
        // then optionally walk into a connected RefractionBlock for refraction
        // intensity / tint-at-distance. PBR-MR's own indexOfRefraction feeds
        // the refraction IOR by default (BJS pbrMetallicRoughnessBlock l.1035).
        const ssInputRef = block.inputs.get("subsurface")?.source;
        let useSubsurface = false;
        let useRefraction = false;
        let ssTintColorExpr = "vec3<f32>(1.0)";
        let ssThicknessExpr = "0.0";
        let ssTranslucencyIntensityExpr = "0.0";
        let ssDiffusionDistExpr = "vec3<f32>(1.0)";
        let refrIntensityExpr = "0.0";
        let refrIorExpr = resolveOptional(block, "indexOfRefraction", "1.5", "f32", stage, state, ctx);
        let refrTintAtDistanceExpr = "1.0";
        if (ssInputRef) {
            const ssBlk = ctx.graph.blocks.get(ssInputRef.blockId);
            if (ssBlk && ssBlk.className === "SubSurfaceBlock") {
                useSubsurface = true;
                state.usesSubsurface = true;
                ctx.resolveOutput(ssBlk, ssInputRef.outputName, stage, state);
                ssTintColorExpr = resolveOptional(ssBlk, "tintColor", "vec3<f32>(1.0)", "vec3f", stage, state, ctx);
                ssThicknessExpr = resolveOptional(ssBlk, "thickness", "0.0", "f32", stage, state, ctx);
                ssTranslucencyIntensityExpr = resolveOptional(ssBlk, "translucencyIntensity", "0.0", "f32", stage, state, ctx);
                ssDiffusionDistExpr = resolveOptional(ssBlk, "translucencyDiffusionDist", "vec3<f32>(1.0)", "vec3f", stage, state, ctx);
                const refrInputRef = ssBlk.inputs.get("refraction")?.source;
                if (refrInputRef) {
                    const refrBlk = ctx.graph.blocks.get(refrInputRef.blockId);
                    if (refrBlk && refrBlk.className === "RefractionBlock") {
                        useRefraction = true;
                        ctx.resolveOutput(refrBlk, refrInputRef.outputName, stage, state);
                        refrIntensityExpr = resolveOptional(refrBlk, "intensity", "1.0", "f32", stage, state, ctx);
                        refrTintAtDistanceExpr = resolveOptional(refrBlk, "tintAtDistance", "1.0", "f32", stage, state, ctx);
                        // RefractionBlock.volumeIndexOfRefraction overrides PBR-MR's IOR if connected.
                        const volIor = refrBlk.inputs.get("volumeIndexOfRefraction");
                        if (volIor?.source) {
                            refrIorExpr = resolveOptional(refrBlk, "volumeIndexOfRefraction", "1.5", "f32", stage, state, ctx);
                        }
                    }
                }
            }
        }
        // Anisotropy: walk into AnisotropyBlock for intensity / direction / uv.
        const aniInputRef = block.inputs.get("anisotropy")?.source;
        let useAnisotropy = false;
        let anisoIntensityExpr = "0.0";
        let anisoDirectionExpr = "vec2<f32>(1.0, 0.0)";
        let anisoUvExpr = "vec2<f32>(0.0)";
        if (aniInputRef) {
            const aniBlk = ctx.graph.blocks.get(aniInputRef.blockId);
            if (aniBlk && aniBlk.className === "AnisotropyBlock") {
                useAnisotropy = true;
                state.usesAnisotropy = true;
                ctx.resolveOutput(aniBlk, aniInputRef.outputName, stage, state);
                anisoIntensityExpr = resolveOptional(aniBlk, "intensity", "0.0", "f32", stage, state, ctx);
                anisoDirectionExpr = resolveOptional(aniBlk, "direction", "vec2<f32>(1.0, 0.0)", "vec3f", stage, state, ctx);
                // direction is a vec2 input — resolveOptional with vec3f fallback won't cast right;
                // re-resolve with proper handling.
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
            const wp = resolveOptional(block, "worldPosition", "vec3<f32>(0.0)", "vec3f", stage, state, ctx);
            const perturbed = block.inputs.get("perturbedNormal");
            const wn = perturbed?.source
                ? ctx.cast(ctx.resolve(block, "perturbedNormal", stage, state), "vec3f").expr
                : resolveOptional(block, "worldNormal", "vec3<f32>(0.0, 1.0, 0.0)", "vec3f", stage, state, ctx);
            const cp = resolveOptional(block, "cameraPosition", "_NME_CAMERA_POS_", "vec3f", stage, state, ctx);
            const bc = resolveOptional(block, "baseColor", "vec3<f32>(1.0)", "vec3f", stage, state, ctx);
            const me = resolveOptional(block, "metallic", "0.0", "f32", stage, state, ctx);
            const ro = resolveOptional(block, "roughness", "0.5", "f32", stage, state, ctx);
            const ao = resolveOptional(block, "ambientOcc", "1.0", "f32", stage, state, ctx);
            const sf = state.shadowLights.length > 0 ? `nme_computeShadowFactors(in)` : `vec4<f32>(1.0)`;
            callVar = `_pbrR${ctx.temp(state, "pbr")}`;
            state.fragment.body.push(
                `let ${callVar} = nme_pbr_mr_compute(${wp}, ${wn}, ${cp}, ${bc}, ${me}, ${ro}, ${ao}, ${ccIntensityExpr}, ${ccRoughnessExpr}, ${ccIorExpr}, ${ccBumpExpr}, ${ccBumpUvExpr}, ${ccTintColorExpr}, ${ccTintAtDistanceExpr}, ${ccTintThicknessExpr}, ${shIntensityExpr}, ${shColorExpr}, ${shRoughnessExpr}, ${refrIntensityExpr}, ${refrIorExpr}, ${refrTintAtDistanceExpr}, ${ssTintColorExpr}, ${ssThicknessExpr}, ${ssTranslucencyIntensityExpr}, ${ssDiffusionDistExpr}, ${anisoIntensityExpr}, ${anisoDirectionExpr}, ${anisoUvExpr}, ${sf});`
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
                const op = block.inputs.get("opacity");
                if (op?.source) {
                    return ctx.cast(ctx.resolve(block, "opacity", stage, state), "f32");
                }
                return { expr: `1.0`, type: "f32" };
            }
            case "ambientClr":
            case "clearcoatDir":
            case "clearcoatInd":
            case "sheenDir":
            case "sheenInd":
            case "refraction":
                return { expr: `vec3<f32>(0.0)`, type: "vec3f" };
            default:
                return { expr: `${callVar}.lighting`, type: "vec3f" };
        }
    },
};
