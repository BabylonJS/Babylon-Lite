import type { NodePbrMrHelperRequest } from "../node-types.js";
import { MAX_LIGHTS } from "../../../light/types.js";

export function buildPbrMrHelperCore(request: NodePbrMrHelperRequest): string {
    if (
        request.useClearcoat ||
        request.useSheen ||
        request.useRefraction ||
        request.useSubsurface ||
        request.useAnisotropy ||
        request.useIridescence ||
        request.useShAlbedoScaling ||
        request.useCcBump ||
        request.useCcTint ||
        request.useSpecularAA ||
        request.remapClearcoatF0
    ) {
        throw new Error("NodeMaterial: PBR-MR core helper cannot emit optional PBR feature code");
    }
    return HELPER_WGSL(request.useEnv);
}

function HELPER_WGSL(useEnv: boolean): string {
    const iblBlock = useEnv
        ? `
    let envRot = sceneU.envRotationY;
    let cosA = cos(envRot); let sinA = sin(envRot);
    let N_specSrc = N;
    let R_raw = reflect(-V, N_specSrc);
    let R = v3(R_raw.x * cosA + R_raw.z * sinA, R_raw.y, -R_raw.x * sinA + R_raw.z * cosA);
    let N_env = v3(Ng.x * cosA + Ng.z * sinA, Ng.y, -Ng.x * sinA + Ng.z * cosA);
    let environmentIrradiance = (sceneU.vSphericalL00.xyz
        + sceneU.vSphericalL1_1.xyz * N_env.y + sceneU.vSphericalL10.xyz * N_env.z + sceneU.vSphericalL11.xyz * N_env.x
        + sceneU.vSphericalL2_2.xyz * (N_env.y * N_env.x) + sceneU.vSphericalL2_1.xyz * (N_env.y * N_env.z)
        + sceneU.vSphericalL20.xyz * (3.0 * N_env.z * N_env.z - 1.0) + sceneU.vSphericalL21.xyz * (N_env.z * N_env.x)
        + sceneU.vSphericalL22.xyz * (N_env.x * N_env.x - N_env.y * N_env.y));
    let brdfSample = textureSample(nmeBrdfLUT, nmeBrdfSampler, v2(NdotV, rough_c));
    let envBrdf = brdfSample.rgb;
    let reflectanceF0Scalar = max(colorF0.r, max(colorF0.g, colorF0.b));
    let baseSpecEnvReflectance = (colorF90 - v3(reflectanceF0Scalar)) * envBrdf.x + v3(reflectanceF0Scalar) * envBrdf.y;
    let seo = clamp((NdotVUnclamped + ao_c) * (NdotVUnclamped + ao_c) - 1.0 + ao_c, 0.0, 1.0);
    let _geoNF = select(-Ng, Ng, dot(Ng, V) > 0.0);
    let _ehoRefl = reflect(-V, N);
    let _ehoT = clamp(1.0 + 1.1 * dot(_ehoRefl, _geoNF), 0.0, 1.0);
    let eho = _ehoT * _ehoT;
    let _coloredR0 = colorF0;
    let colorSpecEnvReflectance = ((colorF90 - _coloredR0) * envBrdf.x + _coloredR0 * envBrdf.y) * seo * eho;
    let energyConservation = 1.0 + _coloredR0 * (1.0 / max(envBrdf.y, 0.001) - 1.0);
    let maxLod = f32(textureNumLevels(nmeIblTexture) - 1);
    let cubemapDim = f32(textureDimensions(nmeIblTexture).x);
    let specLod = log2(cubemapDim * alphaG) * sceneU.vImageInfos.z;
    var environmentRadiance = textureSampleLevel(nmeIblTexture, nmeIblSampler, R, clamp(specLod, 0.0, maxLod)).rgb;
    var finalIrradiance = environmentIrradiance * surfaceAlbedo;
    let finalRadianceScaled = environmentRadiance * colorSpecEnvReflectance * energyConservation;
    let finalSpecularScaledDirect = specAcc * energyConservation;
    let finalRefraction = v3(0.0);
    let refractionOpacity = 1.0;
    let ssRefractionIrradiance = v3(0.0);
    finalIrradiance = finalIrradiance * ao_c;
    r.diffuseInd = finalIrradiance;
    r.specularInd = finalRadianceScaled;
    let shFinalIbl = v3(0.0);
    let shAlbedoScaling: f32 = 1.0;
    r.lighting = finalIrradiance * shAlbedoScaling + ssRefractionIrradiance * ao_c + (finalRadianceScaled + finalSpecularScaledDirect + diffuseAcc) * shAlbedoScaling + diffuseTransmissionAcc + shDirectAcc + shFinalIbl + finalRefraction;`
        : `
    r.diffuseInd = v3(0.0);
    r.specularInd = v3(0.0);
    r.lighting = diffuseAcc + diffuseTransmissionAcc + specAcc + shDirectAcc;`;

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
fn nme_pbr_mr_compute(
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
    shadowFactors: array<f32, ${MAX_LIGHTS}>
) -> NmePbrMrResult {
    var r: NmePbrMrResult;
    let Ng = normalize(geometricNormal);
    let N = normalize(worldNormal);
    let V = normalize(cameraPos - worldPos);
    let NdotVUnclamped = dot(N, V);
    let NdotV = abs(NdotVUnclamped) + 0.0000001;
    let metallic_c = clamp(metallic, 0.0, 1.0);
    let rough_c = clamp(roughness, 0.0, 1.0);
    var alphaG = rough_c * rough_c + 0.0005;
    let AA_factor_x = 0.0;
    let AA_factor_y = 0.0;
    let dielectricF0Raw = (baseIor - 1.0) / (baseIor + 1.0);
    let dielectricF0Scalar = dielectricF0Raw * dielectricF0Raw;
    let dielectricF0 = v3(dielectricF0Scalar);
    var surfaceAlbedo = baseColor * (1.0 - metallic_c) * (1.0 - dielectricF0Scalar);
    let colorF0 = mix(dielectricF0, baseColor, metallic_c);
    let colorF90 = v3(1.0);
    let ao_c = clamp(ao, 0.0, 1.0);
    let directRoughness = max(rough_c, AA_factor_x);
    let directAlphaG = directRoughness * directRoughness + 0.0005;
    let anisoT = v3(1.0, 0.0, 0.0);
    let anisoB = v3(0.0, 0.0, 1.0);
    let aniAlphaTB = v2(alphaG, alphaG);
    let aniN = N;
    let ccDirectSpecAcc = v3(0.0);
    let directSpecR0 = colorF0;
    let ccNormalW = N;
    let ccNdotV: f32 = 0.0;
    let shDirectAcc = v3(0.0);
    let translucencyIntensity = 0.0;
    let ssTransmittance = v3(0.0);
    let directDiffuseTranslucencyScale = 1.0;
    var diffuseAcc = v3(0.0);
    var diffuseTransmissionAcc = v3(0.0);
    var specAcc = v3(0.0);
    var aggShadow: f32 = 0.0;
    var nLights: f32 = 0.0;
    let lc = min(meshU.lc, ${MAX_LIGHTS}u);
    for (var i: u32 = 0u; i < lc; i = i + 1u) {
        let lightIndex = nli(i);
        let entry = nmeLights.lights[lightIndex];
        let t = u32(entry.vLightData.w);
        let sh = shadowFactors[lightIndex];
        if (t == 3u) {
            let Ldir = normalize(entry.vLightData.xyz);
            let nl = clamp(0.5 + 0.5 * dot(N, Ldir), 0.0000001, 1.0);
            let groundSky = mix(entry.vLightDirection.xyz, entry.vLightDiffuse.rgb, nl);
            var baseLayerAtten: f32 = 1.0;
            var baseLayerAbsorption = v3(1.0);
            let H_h = normalize(V + Ldir);
            let NdotH_h = clamp(dot(N, H_h), 0.0000001, 1.0);
            let VdotH_h = saturate(dot(V, H_h));
            let cF_h = nme_pbr_fresSchlick(VdotH_h, directSpecR0, colorF90);
            let D_h = nme_pbr_distGGX(NdotH_h, directAlphaG);
            let G_h = nme_pbr_geomGGX(nl, NdotV, directAlphaG);
            specAcc = specAcc + cF_h * D_h * G_h * nl * entry.vLightDiffuse.rgb * sh * baseLayerAtten * baseLayerAbsorption;
            diffuseAcc = diffuseAcc + groundSky * surfaceAlbedo * sh * baseLayerAtten * baseLayerAbsorption;
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
        var baseLayerAbsorption = v3(1.0);
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
            let D = nme_pbr_distGGX(NdotH, directAlphaG);
            let G = nme_pbr_geomGGX(NdotL, NdotV, directAlphaG);
            specAcc = specAcc + cF * D * G * NdotL * color * atten * sh * baseLayerAtten * baseLayerAbsorption;
        }
        aggShadow = aggShadow + sh;
        nLights = nLights + 1.0;
    }
    r.diffuseDir = diffuseAcc;
    r.specularDir = specAcc;
${iblBlock}
    ${
        useEnv
            ? `let _radLum = clamp(dot(finalRadianceScaled * shAlbedoScaling, v3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    let _specLum = clamp(dot(finalSpecularScaledDirect * shAlbedoScaling, v3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    r.lumOverAlpha = _radLum + _specLum;`
            : `let _specLum = clamp(dot(specAcc, v3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    r.lumOverAlpha = _specLum;`
    }
    var colorOut = max(r.lighting, v3(0.0)) * sceneU.vImageInfos.x;
    if (sceneU.vImageInfos.w > 0.5) {
        colorOut = 1.0 - exp2(-1.590579 * colorOut);
    }
    colorOut = pow(max(colorOut, v3(0.0)), v3(0.45454545));
    colorOut = clamp(colorOut, v3(0.0), v3(1.0));
    let highContrast = colorOut * colorOut * (v3(3.0) - colorOut * 2.0);
    if (sceneU.vImageInfos.y < 1.0) {
        colorOut = mix(v3(0.5), colorOut, sceneU.vImageInfos.y);
    } else {
        colorOut = mix(colorOut, highContrast, sceneU.vImageInfos.y - 1.0);
    }
    r.lighting = max(colorOut, v3(0.0));
    if (nLights > 0.0) { r.shadow = aggShadow / nLights; } else { r.shadow = 1.0; }
    return r;
}
`;
}
