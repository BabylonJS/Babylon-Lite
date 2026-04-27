/** PBRMetallicRoughnessBlock — direct lighting + optional IBL + optional clearcoat.
 *
 *  When the `reflection` input is connected (typically to a ReflectionBlock),
 *  this emitter runs the GGX direct-lighting path PLUS a split-sum IBL
 *  contribution (specular cube + BRDF LUT + SH irradiance).
 *
 *  When the `clearcoat` input is connected (to a ClearCoatBlock), an extra
 *  GGX clear-coat layer is added on top: per-light Schlick fresnel + Kelemen
 *  visibility GGX specular, and the base layer (diffuse + specular + IBL)
 *  is modulated by (1 - ccFresnel * ccIntensity). The clear-coat IBL
 *  contribution samples the same env cube with a roughness-derived LOD.
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
    // Per-light clearcoat specular accumulation: GGX + Kelemen visibility +
    // Schlick fresnel. Updates ccDirectSpecAcc (vec3) and ccDirectAtten (f32).
    return `
        // Clear-coat per-light specular.
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
    // Hemi clearcoat — use sky-half-vector as proxy.
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

function HELPER_WGSL(useEnv: boolean, useClearcoat: boolean): string {
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

    const ccIblFinal = useClearcoat
        ? `let ccFresnelIBL = nme_pbr_ccSchlick(ccF0, NdotV);
    let ccConsIBL = 1.0 - ccFresnelIBL * ccIntensity;
    let ccBrdfX = envBrdf.x;
    let ccBrdfY = envBrdf.y;
    let ccSpecEnvRefl = (vec3<f32>(ccF0) * ccBrdfY + (vec3<f32>(1.0) - vec3<f32>(ccF0)) * ccBrdfX) * ccIntensity;
    let ccSpecLod = log2(cubemapDim * ccAlphaG) * sceneU.lodGenerationScale;
    let ccEnvRadiance = textureSampleLevel(nmeIblTexture, nmeIblSampler, R, clamp(ccSpecLod, 0.0, maxLod)).rgb * sceneU.environmentIntensity;
    let ccFinalRadiance = ccEnvRadiance * ccSpecEnvRefl;
    r.lighting = finalIrradiance * ccConsIBL
        + finalRadianceScaled * ccConsIBL
        + finalSpecularScaledDirect * ccDirectAtten
        + diffuseAcc * ao_c * ccDirectAtten
        + ccDirectSpecAcc
        + ccFinalRadiance;`
        : `r.lighting = finalIrradiance + finalRadianceScaled + finalSpecularScaledDirect + diffuseAcc * ao_c;`;

    const ccDirectFinal = useClearcoat ? `r.lighting = (diffuseAcc + specAcc) * ao_c * ccDirectAtten + ccDirectSpecAcc;` : `r.lighting = (diffuseAcc + specAcc) * ao_c;`;

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
    let energyConservation = 1.0 + colorF0 * (1.0 / max(envBrdf.y, 0.001) - 1.0);
    let maxLod = f32(textureNumLevels(nmeIblTexture) - 1);
    let cubemapDim = f32(textureDimensions(nmeIblTexture).x);
    let specLod = log2(cubemapDim * alphaG) * sceneU.lodGenerationScale;
    var environmentRadiance = textureSampleLevel(nmeIblTexture, nmeIblSampler, R, clamp(specLod, 0.0, maxLod)).rgb * sceneU.environmentIntensity;
    environmentRadiance = mix(environmentRadiance, environmentIrradiance, alphaG);
    let finalIrradiance = environmentIrradiance * surfaceAlbedo * ao_c;
    let finalRadianceScaled = environmentRadiance * specEnvReflectance * energyConservation;
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
${ccSchlickFn}fn nme_pbr_mr_compute(
    worldPos: vec3<f32>, worldNormal: vec3<f32>, cameraPos: vec3<f32>,
    baseColor: vec3<f32>, metallic: f32, roughness: f32, ao: f32,
    ccIntensityIn: f32, ccRoughnessIn: f32, ccIor: f32,
    shadowFactors: vec4<f32>
) -> NmePbrMrResult {
    var r: NmePbrMrResult;
    let N = normalize(worldNormal);
    let V = normalize(cameraPos - worldPos);
    let NdotV = max(abs(dot(N, V)), 0.0001);
    let metallic_c = clamp(metallic, 0.0, 1.0);
    let rough_c = clamp(roughness, 0.04, 1.0);
    let alphaG = max(rough_c * rough_c, 0.0005);
    let dielectricF0 = vec3<f32>(0.04);
    let surfaceAlbedo = baseColor * (1.0 - metallic_c) * (1.0 - 0.04);
    let colorF0 = mix(dielectricF0, baseColor, metallic_c);
    let colorF90 = vec3<f32>(1.0);
    let ao_c = clamp(ao, 0.0, 1.0);
    ${ccDecls}
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
            let Ldir = normalize(entry.vLightData.xyz);
            let nl = 0.5 + 0.5 * dot(N, Ldir);
            let groundSky = mix(entry.vLightDirection.xyz, entry.vLightDiffuse.rgb, nl);
            diffuseAcc = diffuseAcc + groundSky * surfaceAlbedo * sh;
            let H = normalize(V + Ldir);
            let NdotH = clamp(dot(N, H), 0.0000001, 1.0);
            let VdotH = saturate(dot(V, H));
            let D = nme_pbr_distGGX(NdotH, alphaG);
            let G = nme_pbr_geomGGX(max(nl, 0.0001), NdotV, alphaG);
            let cF = nme_pbr_fresSchlick(VdotH, colorF0, colorF90);
            specAcc = specAcc + cF * D * G * max(nl, 0.0) * entry.vLightSpecular.rgb * sh;${ccHemiBlock(useClearcoat)}
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
            let dist = length(toL);
            L = toL / max(dist, 0.0001);
            let range = entry.vLightDiffuse.a;
            atten = max(0.0, 1.0 - dist / range);
            if (t == 2u) {
                let c = max(0.0, dot(entry.vLightDirection.xyz, -L));
                if (c >= entry.vLightDirection.w) {
                    atten = atten * max(0.0, pow(c, entry.vLightSpecular.a));
                } else {
                    atten = 0.0;
                }
            }
        }
        let NdotL = max(dot(N, L), 0.0);
        diffuseAcc = diffuseAcc + surfaceAlbedo * (1.0 / NME_PBR_PI) * NdotL * color * atten * sh;
        if (NdotL > 0.0 && atten > 0.0) {
            let H = normalize(V + L);
            let NdotH = clamp(dot(N, H), 0.0000001, 1.0);
            let VdotH = saturate(dot(V, H));
            let D = nme_pbr_distGGX(NdotH, alphaG);
            let G = nme_pbr_geomGGX(NdotL, NdotV, alphaG);
            let cF = nme_pbr_fresSchlick(VdotH, colorF0, colorF90);
            specAcc = specAcc + cF * D * G * NdotL * color * atten * sh;
        }${ccDirectBlock(useClearcoat)}
        aggShadow = aggShadow + sh;
        nLights = nLights + 1.0;
    }
    r.diffuseDir = diffuseAcc * ao_c;
    r.specularDir = specAcc * ao_c;
${iblBlock}
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
        // Resolve reflection FIRST so the helper variant is decided before injection.
        const reflectionConnected = !!block.inputs.get("reflection")?.source;
        if (reflectionConnected) {
            state.usesEnv = true;
            ctx.resolve(block, "reflection", stage, state);
        }
        // Detect clearcoat connectivity and (if connected) walk into the
        // ClearCoatBlock to gather its parameter inputs.
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
        const helperKey = `${HELPER_KEY_PREFIX}_${reflectionConnected ? "env" : "noenv"}_${useClearcoat ? "cc" : "nocc"}`;
        state.fragment.helpers.set(helperKey, HELPER_WGSL(reflectionConnected, useClearcoat));
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
                `let ${callVar} = nme_pbr_mr_compute(${wp}, ${wn}, ${cp}, ${bc}, ${me}, ${ro}, ${ao}, ${ccIntensityExpr}, ${ccRoughnessExpr}, ${ccIorExpr}, ${sf});`
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
