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

function ccDirectBlock(useClearcoat: boolean): string {
    if (!useClearcoat) {
        return "";
    }
    return `
        // Clear-coat per-light specular (GGX + Kelemen visibility + Schlick).
        if (NdotL > 0.0 && atten > 0.0) {
            let ccH = normalize(V + L);
            let ccNdotH = clamp(dot(N, ccH), 0.0000001, 1.0);
            let ccVdotH = saturate(dot(V, ccH));
            let ccD = nme_pbr_distGGX(ccNdotH, ccAlphaG);
            let ccVis = 0.25 / (ccVdotH * ccVdotH + 0.0000001);
            let ccF_d = nme_pbr_ccSchlick(ccF0, ccVdotH);
            let ccTerm = ccF_d * ccD * ccVis * NdotL;
            ccDirectSpecAcc = ccDirectSpecAcc + vec3<f32>(ccTerm) * color * atten * ccIntensity * sh;
            ccDirectAtten = 1.0 - ccF_d * ccIntensity;
        }`;
}

function ccHemiBlock(useClearcoat: boolean): string {
    if (!useClearcoat) {
        return "";
    }
    return `
        if (nl > 0.0) {
            let ccH_h = normalize(V + Ldir);
            let ccNdotH_h = clamp(dot(N, ccH_h), 0.0000001, 1.0);
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

function HELPER_WGSL(useEnv: boolean, useClearcoat: boolean, useSheen: boolean): string {
    const ccDecls = useClearcoat
        ? `let ccIntensity = clamp(ccIntensityIn, 0.0, 1.0);
    let ccRough = clamp(ccRoughnessIn, 0.0, 1.0);
    let ccAlphaG = max(ccRough * ccRough, 0.0005);
    let ccF0_raw = (ccIor - 1.0) / (ccIor + 1.0);
    let ccF0 = ccF0_raw * ccF0_raw;
    var ccDirectSpecAcc = vec3<f32>(0.0);
    var ccDirectAtten: f32 = 1.0;`
        : `let ccDirectSpecAcc = vec3<f32>(0.0);
    let ccDirectAtten: f32 = 1.0;`;

    const shDecls = useSheen
        ? `let shIntensity = clamp(shIntensityIn, 0.0, 1.0);
    let shRough = clamp(shRoughnessIn, 0.0, 1.0);
    let shAlphaG = max(shRough * shRough, 0.0005);
    let shColorScaled = shColorIn * shIntensity;
    var shDirectAcc = vec3<f32>(0.0);`
        : `let shDirectAcc = vec3<f32>(0.0);`;

    const shIblTerm =
        useEnv && useSheen
            ? `let shSpecLod = log2(cubemapDim * shAlphaG) * sceneU.lodGenerationScale;
    let shEnvRadiance = textureSampleLevel(nmeIblTexture, nmeIblSampler, R, clamp(shSpecLod, 0.0, maxLod)).rgb * sceneU.environmentIntensity;
    let shBrdfBlue = textureSample(nmeBrdfLUT, nmeBrdfSampler, vec2<f32>(NdotV, shRough)).b;
    let shFinalIbl = shEnvRadiance * shColorScaled * shBrdfBlue;`
            : `let shFinalIbl = vec3<f32>(0.0);`;

    const ccIblFinal = useClearcoat
        ? `let ccFresnelIBL = nme_pbr_ccSchlick(ccF0, NdotV);
    let ccConsIBL = 1.0 - ccFresnelIBL * ccIntensity;
    let ccBrdfX = envBrdf.x;
    let ccBrdfY = envBrdf.y;
    let ccSpecEnvRefl = (vec3<f32>(ccF0) * ccBrdfY + (vec3<f32>(1.0) - vec3<f32>(ccF0)) * ccBrdfX) * ccIntensity;
    let ccSpecLod = log2(cubemapDim * ccAlphaG) * sceneU.lodGenerationScale;
    let ccEnvRadiance = textureSampleLevel(nmeIblTexture, nmeIblSampler, R, clamp(ccSpecLod, 0.0, maxLod)).rgb * sceneU.environmentIntensity;
    let ccFinalRadiance = ccEnvRadiance * ccSpecEnvRefl;
    ${shIblTerm}
    r.lighting = finalIrradiance * ccConsIBL
        + finalRadianceScaled * ccConsIBL
        + finalSpecularScaledDirect * ccDirectAtten
        + diffuseAcc * ccDirectAtten
        + ccDirectSpecAcc
        + ccFinalRadiance
        + shDirectAcc
        + shFinalIbl;`
        : `${shIblTerm}
    r.lighting = finalIrradiance + finalRadianceScaled + finalSpecularScaledDirect + diffuseAcc + shDirectAcc + shFinalIbl;`;

    const ccDirectFinal = useClearcoat
        ? `r.lighting = (diffuseAcc + specAcc) * ccDirectAtten + ccDirectSpecAcc + shDirectAcc;`
        : `r.lighting = diffuseAcc + specAcc + shDirectAcc;`;

    const iblBlock = useEnv
        ? `
    // ── Split-sum IBL ──
    let envRot = sceneU.envRotationY;
    let cosA = cos(envRot); let sinA = sin(envRot);
    let R_raw = reflect(-V, N);
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
    // Specular environment occlusion (eho only matters with a normal map; we don't have one).
    let seo = clamp((NdotVUnclamped + ao_c) * (NdotVUnclamped + ao_c) - 1.0 + ao_c, 0.0, 1.0);
    let colorSpecEnvReflectance = specEnvReflectance * seo;
    let energyConservation = 1.0 + colorF0 * (1.0 / max(envBrdf.y, 0.001) - 1.0);
    let maxLod = f32(textureNumLevels(nmeIblTexture) - 1);
    let cubemapDim = f32(textureDimensions(nmeIblTexture).x);
    let specLod = log2(cubemapDim * alphaG) * sceneU.lodGenerationScale;
    var environmentRadiance = textureSampleLevel(nmeIblTexture, nmeIblSampler, R, clamp(specLod, 0.0, maxLod)).rgb * sceneU.environmentIntensity;
    let finalIrradiance = environmentIrradiance * surfaceAlbedo * ao_c;
    let finalRadianceScaled = environmentRadiance * colorSpecEnvReflectance * energyConservation;
    let finalSpecularScaledDirect = specAcc * energyConservation;
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
    let sin2h = max(1.0 - cos2h, 0.0078125);
    return (2.0 + invR) * pow(sin2h, invR * 0.5) / (2.0 * NME_PBR_PI);
}
`
        : ``;

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
${ccSchlickFn}${charlieFn}fn nme_pbr_mr_compute(
    worldPos: vec3<f32>, worldNormal: vec3<f32>, cameraPos: vec3<f32>,
    baseColor: vec3<f32>, metallic: f32, roughness: f32, ao: f32,
    ccIntensityIn: f32, ccRoughnessIn: f32, ccIor: f32,
    shIntensityIn: f32, shColorIn: vec3<f32>, shRoughnessIn: f32,
    shadowFactors: vec4<f32>
) -> NmePbrMrResult {
    var r: NmePbrMrResult;
    let N = normalize(worldNormal);
    let V = normalize(cameraPos - worldPos);
    let NdotVUnclamped = dot(N, V);
    let NdotV = abs(NdotVUnclamped) + 0.0001;
    let metallic_c = clamp(metallic, 0.0, 1.0);
    let rough_c = clamp(roughness, 0.04, 1.0);
    let alphaG = max(rough_c * rough_c, 0.0005);
    let dielectricF0 = vec3<f32>(0.04);
    let surfaceAlbedo = baseColor * (1.0 - metallic_c) * (1.0 - 0.04);
    let colorF0 = mix(dielectricF0, baseColor, metallic_c);
    let colorF90 = vec3<f32>(1.0);
    let ao_c = clamp(ao, 0.0, 1.0);
    // Direct-light path uses its own roughness clamp (BJS pbrDirectLightingFunctions.fx l.103).
    let directAlphaG = max(rough_c * rough_c, 0.0005);
    ${ccDecls}
    ${shDecls}
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
            diffuseAcc = diffuseAcc + groundSky * surfaceAlbedo * sh;${ccHemiBlock(useClearcoat)}${shHemiBlock(useSheen)}
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
            let D = nme_pbr_distGGX(NdotH, directAlphaG);
            let G = nme_pbr_geomGGX(NdotL, NdotV, directAlphaG);
            let cF = nme_pbr_fresSchlick(VdotH, colorF0, colorF90);
            specAcc = specAcc + cF * D * G * NdotL * color * atten * sh;
        }${ccDirectBlock(useClearcoat)}${shDirectBlock(useSheen)}
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
        // Clearcoat: walk into ClearCoatBlock to gather params.
        const ccInputRef = block.inputs.get("clearcoat")?.source;
        let ccIntensityExpr = "0.0";
        let ccRoughnessExpr = "0.0";
        let ccIorExpr = "1.5";
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
            }
        }
        // Sheen: walk into SheenBlock to gather params.
        const shInputRef = block.inputs.get("sheen")?.source;
        let shIntensityExpr = "0.0";
        let shColorExpr = "vec3<f32>(1.0)";
        let shRoughnessExpr = "0.0";
        let useSheen = false;
        if (shInputRef) {
            const shBlock = ctx.graph.blocks.get(shInputRef.blockId);
            if (shBlock && shBlock.className === "SheenBlock") {
                useSheen = true;
                state.usesSheen = true;
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
        const helperKey = `${HELPER_KEY_PREFIX}_${reflectionConnected ? "env" : "noenv"}_${useClearcoat ? "cc" : "nocc"}_${useSheen ? "sh" : "nosh"}`;
        state.fragment.helpers.set(helperKey, HELPER_WGSL(reflectionConnected, useClearcoat, useSheen));
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
                `let ${callVar} = nme_pbr_mr_compute(${wp}, ${wn}, ${cp}, ${bc}, ${me}, ${ro}, ${ao}, ${ccIntensityExpr}, ${ccRoughnessExpr}, ${ccIorExpr}, ${shIntensityExpr}, ${shColorExpr}, ${shRoughnessExpr}, ${sf});`
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
