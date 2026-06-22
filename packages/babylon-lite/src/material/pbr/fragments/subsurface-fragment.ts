/**
 * Subsurface Fragment
 *
 * Adds translucency — light passing through thin surfaces.
 * Only bundled when a scene uses PbrMaterialProps.subsurface.
 *
 * Math follows BJS PBRSubSurfaceConfiguration:
 *  - Burley transmittance BRDF: exp-based approximation
 *  - Thickness from texture (.g channel, BJS glTF-style default)
 *  - Direct: wrap-around diffuse scaled by transmittance
 *  - IBL: irradiance reduced by (1 - intensity), transmittance-weighted contribution added
 */

import type { ShaderFragment, BindingDecl, UboField } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps, SubSurfaceProps } from "../pbr-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_SUBSURFACE, PBR_HAS_THICKNESS_MAP, PBR2_HAS_THICKNESS_GLTF_CHANNEL } from "../pbr-flag-bits.js";

// Subsurface-only features2 bits (reserved in pbr-flag-bits.ts). Defined here,
// not in the shared flag module, so they aren't retained in the entry/shared
// chunk for scenes that never load this lazy fragment (zero bundle movement).
const PBR2_HAS_TRANSLUCENCY_COLOR_MAP = 1 << 22;
const PBR2_HAS_TRANSLUCENCY_INTENSITY_MAP = 1 << 23;
const PBR2_HAS_TRANSLUCENCY_UV_TX = 1 << 24;

const SS_HELPERS = `
fn transmittanceBRDF_Burley(tintColor: vec3<f32>, diffusionDistance: vec3<f32>, thickness: f32) -> vec3<f32> {
let S = 1.0 / max(vec3<f32>(0.000001), diffusionDistance);
let temp = exp((-0.333333333 * thickness) * S);
return tintColor * 0.25 * (temp * temp * temp + 3.0 * temp);
}
fn computeWrappedDiffuseNdotL(NdotL: f32, w: f32) -> f32 {
let t = 1.0 + w;
let invt2 = 1.0 / (t * t);
return saturate((NdotL + w) * invt2);
}
`;

// SV: declare subsurface scope variables
const SS_SCOPE_VARS = `var translucencyDirect = vec3<f32>(0.0);
var ssTransmittance = vec3<f32>(0.0);
var ssIntensity = 0.0;`;

// AT: sample thickness + compute transmittance.
// Channel: R by default (matches existing non-glTF path); G when the glTF
// KHR_materials_volume flag is on (spec mandates G channel).
function makeThicknessBlock(hasThicknessMap: boolean, useGltfChannel: boolean, hasColorMap: boolean, hasIntensityMap: boolean, hasUvTx: boolean): string {
    const chan = useGltfChannel ? "g" : "r";
    const texSample = hasThicknessMap ? `let thicknessSample = textureSample(thicknessTexture_, thicknessSampler_, input.uv).${chan};` : `let thicknessSample = 1.0;`;
    // The translucency color and intensity textures each carry their own
    // KHR_texture_transform (driven live by animation pointers), so they are
    // sampled with independent transformed UVs.
    let uvDecl = "";
    let colorUv = "input.uv";
    let intensityUv = "input.uv";
    if (hasUvTx && hasColorMap) {
        uvDecl += `let ssColorUV = vec2<f32>(dot(material.translucencyColorUVm.xy, input.uv), dot(material.translucencyColorUVm.zw, input.uv)) + material.translucencyColorUVt.xy;\n`;
        colorUv = "ssColorUV";
    }
    if (hasUvTx && hasIntensityMap) {
        uvDecl += `let ssIntUV = vec2<f32>(dot(material.translucencyIntensityUVm.xy, input.uv), dot(material.translucencyIntensityUVm.zw, input.uv)) + material.translucencyIntensityUVt.xy;\n`;
        intensityUv = "ssIntUV";
    }
    const colorMul = hasColorMap ? ` * textureSample(translucencyColorTexture_, translucencyColorSampler_, ${colorUv}).rgb` : ``;
    const intensityMul = hasIntensityMap ? ` * textureSample(translucencyIntensityTexture_, translucencyIntensitySampler_, ${intensityUv}).a` : ``;
    return `${uvDecl}${texSample}
let ssThickness = max(material.subsurfaceParams.y + thicknessSample * material.subsurfaceParams.z, 0.000001);
let ssTranslucencyColor = material.subsurfaceParams3.rgb${colorMul};
let ssDiffDist = material.subsurfaceParams2.rgb;
ssIntensity = material.subsurfaceParams.x${intensityMul};
ssTransmittance = transmittanceBRDF_Burley(ssTranslucencyColor, ssDiffDist, ssThickness) * ssIntensity;`;
}

// AD: direct-light translucency lobe (back-facing only, wrap 0.02, 1/PI diffuse BRDF).
// BJS also scales the front-facing direct diffuse by (1 - ssIntensity); we cannot easily
// modify `directDiffuse` at compute time, so compensate via `color -= directDiffuse * ssIntensity`
// in the AI/NI slot below.
const SS_DIRECT = `{
let NdotLU = dot(N, L);
if (NdotLU < 0.0) {
let wrapNdotL = computeWrappedDiffuseNdotL(abs(NdotLU), 0.02);
translucencyDirect += (1.0 / PI) * wrapNdotL * ssTransmittance * lightAtten * lightColor * material.directIntensity;
}
}`;

// AI: subsurface IBL modification (runs after IBL sets `color`).
// BJS: finalIrradiance *= (1 - ssI);  finalIrradiance += refractionIrradiance;
// where refractionIrradiance = environmentIrradiance(-N) * transmittance (no albedo by default).
// AO/occlusion applies to the full finalIrradiance in BJS.
// Also: scale direct diffuse by (1-ssI) and add translucencyDirect lobe.
const SS_IBL_MOD = `{
let N_back = -N_env;
let envIrrBack = (scene.vSphericalL00.rgb
  + scene.vSphericalL1_1.rgb * N_back.y + scene.vSphericalL10.rgb * N_back.z + scene.vSphericalL11.rgb * N_back.x
  + scene.vSphericalL2_2.rgb * (N_back.y * N_back.x) + scene.vSphericalL2_1.rgb * (N_back.y * N_back.z)
  + scene.vSphericalL20.rgb * (3.0 * N_back.z * N_back.z - 1.0) + scene.vSphericalL21.rgb * (N_back.z * N_back.x)
  + scene.vSphericalL22.rgb * (N_back.x * N_back.x - N_back.y * N_back.y)) * material.environmentIntensity;
let refractionIrradiance = envIrrBack * ssTransmittance;
color -= finalIrradiance * ssIntensity;
color += refractionIrradiance * occlusion;
color -= directDiffuse * ssIntensity;
color += translucencyDirect * occlusion;
}`;

// NI: no-IBL path — just scale direct diffuse and add translucency lobe.
const SS_NO_IBL_MOD = `color -= directDiffuse * ssIntensity;
color += translucencyDirect;`;

const STAGE_FRAGMENT = 0x2;

/**
 * Create a subsurface translucency fragment.
 * @param hasThicknessMap - Whether the material has a thickness texture.
 * @param hasIbl - Whether the scene has IBL.
 * @param useGltfThicknessChannel - Sample the thickness texture's G channel
 *        (KHR_materials_volume) instead of R (BJS default).
 */
export function createSubsurfaceFragment(
    hasThicknessMap: boolean,
    hasIbl: boolean,
    useGltfThicknessChannel: boolean,
    hasColorMap: boolean,
    hasIntensityMap: boolean,
    hasUvTx: boolean
): ShaderFragment {
    const tex2d = { _kind: "texture" as const, _textureType: "texture_2d<f32>" as const };
    const samp = { _kind: "sampler" as const, _samplerType: "sampler" as const };
    const bindings: BindingDecl[] = [];
    if (hasThicknessMap) {
        bindings.push({ _name: "thicknessTexture_", _type: tex2d, _visibility: STAGE_FRAGMENT }, { _name: "thicknessSampler_", _type: samp, _visibility: STAGE_FRAGMENT });
    }
    if (hasColorMap) {
        bindings.push(
            { _name: "translucencyColorTexture_", _type: tex2d, _visibility: STAGE_FRAGMENT },
            { _name: "translucencyColorSampler_", _type: samp, _visibility: STAGE_FRAGMENT }
        );
    }
    if (hasIntensityMap) {
        bindings.push(
            { _name: "translucencyIntensityTexture_", _type: tex2d, _visibility: STAGE_FRAGMENT },
            { _name: "translucencyIntensitySampler_", _type: samp, _visibility: STAGE_FRAGMENT }
        );
    }

    const uboFields: UboField[] = [
        { _name: "subsurfaceParams", _type: "vec4<f32>" },
        { _name: "subsurfaceParams2", _type: "vec4<f32>" },
        { _name: "subsurfaceParams3", _type: "vec4<f32>" },
    ];
    if (hasUvTx && hasColorMap) {
        uboFields.push({ _name: "translucencyColorUVm", _type: "vec4<f32>" }, { _name: "translucencyColorUVt", _type: "vec4<f32>" });
    }
    if (hasUvTx && hasIntensityMap) {
        uboFields.push({ _name: "translucencyIntensityUVm", _type: "vec4<f32>" }, { _name: "translucencyIntensityUVt", _type: "vec4<f32>" });
    }

    const slots: Partial<Record<string, string>> = {
        SV: SS_SCOPE_VARS,
        AT: makeThicknessBlock(hasThicknessMap, useGltfThicknessChannel, hasColorMap, hasIntensityMap, hasUvTx),
        AD: SS_DIRECT,
    };
    if (hasIbl) {
        slots.AI = SS_IBL_MOD;
    } else {
        slots.NI = SS_NO_IBL_MOD;
    }

    const deps: string[] = [];
    if (hasIbl) {
        deps.push("ibl");
    }

    return {
        _id: "subsurface",
        _dependencies: deps.length > 0 ? deps : undefined,
        _bindings: bindings.length > 0 ? bindings : undefined,
        _uboFields: uboFields,
        _helperFunctions: SS_HELPERS,
        _fragmentSlots: slots,
    };
}

/** Write subsurface UBO data. Called from pbr-renderable.ts only when subsurface is active. */
export function writeSubsurfaceUBO(data: Float32Array, ss: SubSurfaceProps, offsets: ReadonlyMap<string, number>): void {
    const trans = ss.translucency!;
    const thick = ss.thickness;

    const off = offsets.get("subsurfaceParams")! / 4;
    data[off] = trans.intensity ?? 1.0;
    const minThick = thick?.min ?? 0;
    const maxThick = thick?.max ?? 1.0;
    data[off + 1] = minThick;
    data[off + 2] = maxThick - minThick;

    const off2 = offsets.get("subsurfaceParams2")! / 4;
    const dd = trans.diffusionDistance ?? [1, 1, 1];
    data[off2] = dd[0]!;
    data[off2 + 1] = dd[1]!;
    data[off2 + 2] = dd[2]!;

    const off3 = offsets.get("subsurfaceParams3")! / 4;
    const tc = trans.color ?? [1, 1, 1];
    data[off3] = tc[0]!;
    data[off3 + 1] = tc[1]!;
    data[off3 + 2] = tc[2]!;

    // Per-texture UV transforms (each KHR_texture_transform driven live by
    // animation pointers). Same mat2+translate layout as the iridescence writer.
    writeSsUvTransform(data, offsets, "translucencyColorUV", trans.colorTexture);
    writeSsUvTransform(data, offsets, "translucencyIntensityUV", trans.intensityTexture);
}

/** Write a 2x2 UV matrix (vec4) + translate (vec4) for a translucency texture. */
function writeSsUvTransform(
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

export const pbrExt: PbrExt = {
    id: "subsurface",
    phase: "fragment",
    detect(mat) {
        const m = mat as PbrMaterialProps;
        const trans = m.subsurface?.translucency;
        if (!trans) {
            return { f: 0, f2: 0 };
        }
        let f = PBR_HAS_SUBSURFACE;
        let f2 = 0;
        if (m.subsurface!.thickness?.texture) {
            f |= PBR_HAS_THICKNESS_MAP;
        }
        if (m.subsurface!.thickness?.useGlTFChannel) {
            f2 |= PBR2_HAS_THICKNESS_GLTF_CHANNEL;
        }
        if (trans.colorTexture) {
            f2 |= PBR2_HAS_TRANSLUCENCY_COLOR_MAP;
        }
        if (trans.intensityTexture) {
            f2 |= PBR2_HAS_TRANSLUCENCY_INTENSITY_MAP;
        }
        if ((trans.colorTexture as { _hasTx?: boolean } | undefined)?._hasTx || (trans.intensityTexture as { _hasTx?: boolean } | undefined)?._hasTx) {
            f2 |= PBR2_HAS_TRANSLUCENCY_UV_TX;
        }
        return { f, f2 };
    },
    frag(ctx) {
        if (!(ctx._features & PBR_HAS_SUBSURFACE)) {
            return null;
        }
        return createSubsurfaceFragment(
            (ctx._features & PBR_HAS_THICKNESS_MAP) !== 0,
            ctx._hasIbl,
            (ctx._features2 & PBR2_HAS_THICKNESS_GLTF_CHANNEL) !== 0,
            (ctx._features2 & PBR2_HAS_TRANSLUCENCY_COLOR_MAP) !== 0,
            (ctx._features2 & PBR2_HAS_TRANSLUCENCY_INTENSITY_MAP) !== 0,
            (ctx._features2 & PBR2_HAS_TRANSLUCENCY_UV_TX) !== 0
        );
    },
    writeUbo(data, mat, offsets) {
        const m = mat as PbrMaterialProps;
        if (m.subsurface?.translucency && offsets.has("subsurfaceParams")) {
            writeSubsurfaceUBO(data, m.subsurface as SubSurfaceProps, offsets);
        }
    },
    bind(ctx, entries, b) {
        const ss = (ctx._material as PbrMaterialProps).subsurface;
        if ((ctx._features & PBR_HAS_THICKNESS_MAP) !== 0) {
            const tex = ss?.thickness?.texture as Texture2D | undefined;
            if (tex) {
                entries.push({ binding: b++, resource: tex.view });
                entries.push({ binding: b++, resource: tex.sampler });
            }
        }
        if ((ctx._features2 & PBR2_HAS_TRANSLUCENCY_COLOR_MAP) !== 0) {
            const tex = ss?.translucency?.colorTexture as Texture2D | undefined;
            if (tex) {
                entries.push({ binding: b++, resource: tex.view });
                entries.push({ binding: b++, resource: tex.sampler });
            }
        }
        if ((ctx._features2 & PBR2_HAS_TRANSLUCENCY_INTENSITY_MAP) !== 0) {
            const tex = ss?.translucency?.intensityTexture as Texture2D | undefined;
            if (tex) {
                entries.push({ binding: b++, resource: tex.view });
                entries.push({ binding: b++, resource: tex.sampler });
            }
        }
        return b;
    },
    textures(mat, out) {
        const ss = (mat as PbrMaterialProps).subsurface;
        if (ss?.thickness?.texture) {
            out.push(ss.thickness.texture);
        }
        if (ss?.translucency?.colorTexture) {
            out.push(ss.translucency.colorTexture);
        }
        if (ss?.translucency?.intensityTexture) {
            out.push(ss.translucency.intensityTexture);
        }
    },
};
