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

import type { ShaderFragment, BindingDecl, UboField } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps, ClearCoatProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import {
    PBR_HAS_CLEARCOAT,
    PBR_HAS_METALLIC_REFLECTANCE_MAP,
    PBR_HAS_REFLECTANCE_MAP,
    PBR2_CC_INT_MAP,
    PBR2_CC_ROUGH_MAP,
    PBR2_CC_NORMAL_MAP,
    PBR2_CC_F0_REMAP_OFF,
} from "../pbr-flag-bits.js";

// Clearcoat-only features2 bit (reserved in pbr-flag-bits.ts). Defined here, not
// in the shared flag module, for zero bundle movement on scenes that never load
// this lazy fragment.
const PBR2_CC_UV_TX = 1 << 25;

const STAGE_FRAGMENT = 0x2;

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
fn ccSchlick(f0: f32, cosTheta: f32) -> f32 {
let t = 1.0 - cosTheta;
let t2 = t * t;
return f0 + (1.0 - f0) * (t2 * t2 * t);
}
`;

const ccUvExpr = (name: string): string => `(vec2<f32>(dot(material.${name}m.xy, input.uv), dot(material.${name}m.zw, input.uv)) + material.${name}t.xy)`;
const CC_INT_TEX = (uv: string): string => `material.ccParams.x * textureSample(ccIntensityTexture, ccIntensitySampler_, ${uv}).r`;
const CC_INT_PLAIN = `material.ccParams.x`;
const CC_ROUGH_TEX = (uv: string): string => `clamp(material.ccParams.y * textureSample(ccRoughnessTexture, ccRoughnessSampler_, ${uv}).g, 0.0, 1.0)`;
const CC_ROUGH_PLAIN = `material.ccParams.y`;

// WGSL fragment: coat-layer normal. Computes ccN (coat world-space normal)
// using a locally-derived cotangent frame from world-position and UV derivatives.
// Emitted in /*AC*/ so ccN is in scope for direct + IBL blocks.
const CC_NORMAL_COMPUTE = (uv: string): string => `
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
let ccNormSampleRaw = textureSample(ccNormalTexture, ccNormalSampler_, ${uv}).rgb * 2.0 - 1.0;
let ccNormScale = material.ccParams.z;
var ccN = normalize(cc_frame * normalize(ccNormSampleRaw * vec3<f32>(ccNormScale, ccNormScale, 1.0)));
`;

function makeF0Remap(intensityExpr: string): string {
    return `
{
let ccInt_r = ${intensityExpr};
let remappedF0 = getR0RemappedForClearCoat(colorF0, material.ccRefractionParams.z, material.ccRefractionParams.w);
colorF0 = mix(colorF0, remappedF0, ccInt_r);
}
`;
}

function makeDirectMod(intensityExpr: string, roughnessExpr: string, hasNormalMap: boolean): string {
    const N = hasNormalMap ? "ccN" : "N_geom";
    return `
var ccDirectAttenuation = 1.0;
var ccDirectSpecularTerm = vec3<f32>(0.0);
{
let ccInt_dl = ${intensityExpr};
let ccRough_dl = ${roughnessExpr};
let ccF0_dl = material.ccRefractionParams.x;
let ccAlphaG_dl = ccRough_dl * ccRough_dl + 0.0005;
let ccNdotL_dl = saturate(dot(${N}, L));
let ccH_dl = normalize(V + L);
let ccNdotH_dl = clamp(dot(${N}, ccH_dl), 0.0000001, 1.0);
let ccVdotH_dl = saturate(dot(V, ccH_dl));
let ccD_dl = distributionGGX(ccNdotH_dl, ccAlphaG_dl);
let ccVis_dl = visibility_Kelemen(ccVdotH_dl);
let ccFresnel_dl = ccSchlick(ccF0_dl, ccVdotH_dl);
let ccTerm = ccFresnel_dl * ccD_dl * ccVis_dl * ccNdotL_dl;
ccDirectSpecularTerm = vec3<f32>(ccTerm) * lightColor * lightAtten * material.directIntensity * ccInt_dl;
ccDirectAttenuation = 1.0 - ccFresnel_dl * ccInt_dl;
}
`;
}

function makeIblMod(intensityExpr: string, roughnessExpr: string, hasNormalMap: boolean, hasSpecularAA: boolean, hasBaseNormalMap: boolean): string {
    const N = hasNormalMap ? "ccN" : "N_geom";
    const alphaG = hasSpecularAA
        ? `let ccAlphaG_ibl_base = ccRough_ibl * ccRough_ibl + 0.0005;
let cc_nDfdx_AA = dpdx(${N});
let cc_nDfdy_AA = dpdy(${N});
let cc_slopeSquare_AA = max(dot(cc_nDfdx_AA, cc_nDfdx_AA), dot(cc_nDfdy_AA, cc_nDfdy_AA));
let ccAlphaG_ibl = ccAlphaG_ibl_base + sqrt(cc_slopeSquare_AA) * 0.75;`
        : `let ccAlphaG_ibl = ccRough_ibl * ccRough_ibl + 0.0005;`;
    const ehoLine = hasBaseNormalMap ? `let ccEho_ibl = environmentHorizonOcclusion(-V, ${N}, N_geom);` : `let ccEho_ibl = 1.0;`;
    return `
{
let ccInt_ibl = ${intensityExpr};
let ccRough_ibl = ${roughnessExpr};
let ccF0_ibl = material.ccRefractionParams.x;
let ccR_raw = reflect(-V, ${N});
let ccR_ibl = rotateY(ccR_raw, scene.envRotationY);
let ccNdotV_ibl = abs(dot(${N}, V)) + 0.0000001;
${alphaG}
var ccSpecLod_ibl = log2(cubemapDim * ccAlphaG_ibl) * scene.vImageInfos.z;
let ccEnvRadiance_ibl = textureSampleLevel(iblTexture, iblSampler, ccR_ibl, clamp(ccSpecLod_ibl, 0.0, maxLod)).rgb * material.environmentIntensity;
let ccBrdf_ibl = textureSample(brdfLUT, brdfSampler_, vec2<f32>(ccNdotV_ibl, ccRough_ibl)).rgb;
${ehoLine}
let ccSpecEnvRefl = (vec3<f32>(ccF0_ibl) * ccBrdf_ibl.y + (vec3<f32>(1.0) - vec3<f32>(ccF0_ibl)) * ccBrdf_ibl.x) * ccInt_ibl * ccEho_ibl;
let ccFresnelIBL = ccSchlick(ccF0_ibl, ccNdotV_ibl);
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

function makeNonIblMod(intensityExpr: string): string {
    return `
{
let ccF0_noIbl = material.ccRefractionParams.x;
let ccInt_noIbl = ${intensityExpr};
let ccFresnelNoIbl = ccSchlick(ccF0_noIbl, NdotV);
let ccCons_noIbl = 1.0 - ccFresnelNoIbl * ccInt_noIbl;
color = (color - emissive) * ccCons_noIbl + emissive + ccDirectSpecularTerm;
}
`;
}

export function createClearcoatFragment(features: number, features2: number, hasIbl: boolean, hasBaseNormalMap: boolean, hasSpecularAA: boolean): ShaderFragment | null {
    if ((features & PBR_HAS_CLEARCOAT) === 0) {
        return null;
    }
    const hasReflectance = (features & (PBR_HAS_METALLIC_REFLECTANCE_MAP | PBR_HAS_REFLECTANCE_MAP)) !== 0;
    const hasIntensityMap = (features2 & PBR2_CC_INT_MAP) !== 0;
    const hasRoughnessMap = (features2 & PBR2_CC_ROUGH_MAP) !== 0;
    const hasNormalMap = (features2 & PBR2_CC_NORMAL_MAP) !== 0;
    const disableF0Remap = (features2 & PBR2_CC_F0_REMAP_OFF) !== 0;
    const hasUvTx = (features2 & PBR2_CC_UV_TX) !== 0;
    const intUv = hasUvTx ? ccUvExpr("ccIntUV") : "input.uv";
    const roughUv = hasUvTx ? ccUvExpr("ccRoughUV") : "input.uv";
    const normUv = hasUvTx ? ccUvExpr("ccNormUV") : "input.uv";
    const intensityExpr = hasIntensityMap ? CC_INT_TEX(intUv) : CC_INT_PLAIN;
    const roughnessExpr = hasRoughnessMap ? CC_ROUGH_TEX(roughUv) : CC_ROUGH_PLAIN;
    const slots: Partial<Record<string, string>> = {
        MF: disableF0Remap ? "" : makeF0Remap(intensityExpr),
        AD: makeDirectMod(intensityExpr, roughnessExpr, hasNormalMap),
        BL: `var ccDirectAttenuation = 1.0;\nvar ccDirectSpecularTerm = vec3<f32>(0.0);`,
    };
    if (hasNormalMap) {
        slots.AC = CC_NORMAL_COMPUTE(normUv);
    }
    // AI and NI are mutually exclusive — only one path runs
    if (hasIbl) {
        slots.AI = makeIblMod(intensityExpr, roughnessExpr, hasNormalMap, hasSpecularAA, hasBaseNormalMap);
    } else {
        slots.NI = makeNonIblMod(intensityExpr);
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
        (hasBaseNormalMap ? "B" : "") +
        (hasUvTx ? "U" : "");
    const bindings: BindingDecl[] = [];
    if (hasIntensityMap) {
        bindings.push(
            { _name: "ccIntensityTexture", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "ccIntensitySampler_", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT }
        );
    }
    if (hasRoughnessMap) {
        bindings.push(
            { _name: "ccRoughnessTexture", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "ccRoughnessSampler_", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT }
        );
    }
    if (hasNormalMap) {
        bindings.push(
            { _name: "ccNormalTexture", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "ccNormalSampler_", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT }
        );
    }

    const uboFields: UboField[] = [
        { _name: "ccParams", _type: "vec4<f32>" },
        { _name: "ccRefractionParams", _type: "vec4<f32>" },
    ];
    if (hasUvTx) {
        if (hasIntensityMap) {
            uboFields.push({ _name: "ccIntUVm", _type: "vec4<f32>" }, { _name: "ccIntUVt", _type: "vec4<f32>" });
        }
        if (hasRoughnessMap) {
            uboFields.push({ _name: "ccRoughUVm", _type: "vec4<f32>" }, { _name: "ccRoughUVt", _type: "vec4<f32>" });
        }
        if (hasNormalMap) {
            uboFields.push({ _name: "ccNormUVm", _type: "vec4<f32>" }, { _name: "ccNormUVt", _type: "vec4<f32>" });
        }
    }

    return {
        _id: suffix ? `clearcoat-${suffix}` : "clearcoat",
        _dependencies: deps.length > 0 ? deps : undefined,

        _uboFields: uboFields,

        _bindings: bindings,

        _helperFunctions: CC_HELPERS,

        _fragmentSlots: slots,
    };
}

/** Write the clearcoat material-UBO slice (ccParams + ccParams2). */
export function writeClearcoatUBO(data: Float32Array, material: PbrMaterialProps, offsets: ReadonlyMap<string, number>): void {
    const cc = material.clearCoat as ClearCoatProps | undefined;
    if (!cc?.isEnabled || !offsets.has("ccParams")) {
        return;
    }
    const off = offsets.get("ccParams")! / 4;
    const ior = cc.indexOfRefraction ?? 1.5;
    const a = 1 - ior;
    const b = 1 + ior;
    data[off] = cc.intensity ?? 1.0;
    data[off + 1] = cc.roughness ?? 0.0;
    data[off + 2] = cc.bumpTextureScale ?? 1.0;
    data[off + 4] = Math.pow(-a / b, 2);
    data[off + 5] = 1 / ior;
    data[off + 6] = a;
    data[off + 7] = b;

    writeCcUvTransform(data, offsets, "ccIntUV", cc.texture);
    writeCcUvTransform(data, offsets, "ccRoughUV", cc.roughnessTexture);
    writeCcUvTransform(data, offsets, "ccNormUV", cc.bumpTexture);
}

/** Write a 2x2 UV matrix (vec4) + translate (vec4) for a clearcoat texture. */
function writeCcUvTransform(
    data: Float32Array,
    offsets: ReadonlyMap<string, number>,
    name: string,
    tex: { uScale?: number; vScale?: number; uAng?: number; uOffset?: number; vOffset?: number } | undefined
): void {
    const mOff = offsets.get(`${name}m`);
    const tOff = offsets.get(`${name}t`);
    if (mOff === undefined || tOff === undefined) {
        return;
    }
    const sx = tex?.uScale ?? 1;
    const sy = tex?.vScale ?? 1;
    const ang = tex?.uAng ?? 0;
    const mi = mOff / 4;
    if (ang === 0) {
        data[mi] = sx;
        data[mi + 1] = 0;
        data[mi + 2] = 0;
        data[mi + 3] = sy;
    } else {
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        data[mi] = c * sx;
        data[mi + 1] = s * sy;
        data[mi + 2] = -s * sx;
        data[mi + 3] = c * sy;
    }
    const ti = tOff / 4;
    data[ti] = tex?.uOffset ?? 0;
    data[ti + 1] = tex?.vOffset ?? 0;
}

const CC_TEX: ReadonlyArray<readonly [number, "texture" | "roughnessTexture" | "bumpTexture"]> = [
    [PBR2_CC_INT_MAP, "texture"],
    [PBR2_CC_ROUGH_MAP, "roughnessTexture"],
    [PBR2_CC_NORMAL_MAP, "bumpTexture"],
];

/** Clearcoat PBR extension (group 1, base-tex phase). */
export const pbrExt: PbrExt = {
    id: "clearcoat",
    phase: "base-tex",
    detect(mat) {
        const cc = (mat as PbrMaterialProps).clearCoat as ClearCoatProps | undefined;
        if (!cc?.isEnabled) {
            return { f: 0, f2: 0 };
        }
        let f2 = 0;
        for (const [flag, key] of CC_TEX) {
            if (cc[key]) {
                f2 |= flag;
            }
        }
        const ccHasTx = (t: { _hasTx?: boolean } | undefined): boolean => !!t?._hasTx;
        if (
            ccHasTx(cc.texture as { _hasTx?: boolean } | undefined) ||
            ccHasTx(cc.roughnessTexture as { _hasTx?: boolean } | undefined) ||
            ccHasTx(cc.bumpTexture as { _hasTx?: boolean } | undefined)
        ) {
            f2 |= PBR2_CC_UV_TX;
        }
        if (cc.useF0Remap === false) {
            f2 |= PBR2_CC_F0_REMAP_OFF;
        }
        return { f: PBR_HAS_CLEARCOAT, f2 };
    },
    frag: (ctx) => createClearcoatFragment(ctx._features, ctx._features2, ctx._hasIbl, ctx._hasAnyNormal, ctx._hasSpecularAA),
    writeUbo: writeClearcoatUBO as PbrExt["writeUbo"],
    bind(ctx, entries, b) {
        const cc = (ctx._material as PbrMaterialProps).clearCoat as ClearCoatProps | undefined;
        if (!cc) {
            return b;
        }
        for (const [flag, key] of CC_TEX) {
            const tex = cc[key];
            if ((ctx._features2 & flag) !== 0 && tex) {
                entries.push({ binding: b++, resource: tex.view });
                entries.push({ binding: b++, resource: tex.sampler });
            }
        }
        return b;
    },
    textures(mat, t) {
        const cc = (mat as PbrMaterialProps).clearCoat;
        if (!cc) {
            return;
        }
        for (const [, key] of CC_TEX) {
            const tex = cc[key];
            if (tex) {
                t.push(tex);
            }
        }
    },
};
