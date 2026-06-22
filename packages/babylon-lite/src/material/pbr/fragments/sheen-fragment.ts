/**
 * Sheen Fragment
 *
 * Adds a soft velvet-like sheen layer (fabric, cloth).
 * Only bundled when a scene uses PbrMaterialProps.sheen.
 *
 * Math follows BJS PBRSheenConfiguration:
 *  - Charlie NDF (sheen distribution)
 *  - Ashikhmin visibility
 *  - IBL: environment sampled at sheen roughness, BRDF LUT blue channel
 *  - Energy conservation: albedo scaled by (1 - maxSheenColor * brdf.b)
 */

import type { ShaderFragment, BindingDecl, UboField } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps, SheenProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_SHEEN, PBR_HAS_SHEEN_TEXTURE, PBR_HAS_SHEEN_ALBEDO_SCALING, PBR2_HAS_SHEEN_UV_TX } from "../pbr-flag-bits.js";

const STAGE_FRAGMENT = 0x2;

// Extension-local features2 bit (defined here, not in the shared flag module, so scenes
// without a separate sheen roughness texture carry zero bytes for it). Set when the material
// has a KHR_materials_sheen sheenRoughnessTexture distinct from sheenColorTexture: sheen
// roughness is then read from that texture's A channel at its own (animatable) UV transform.
const PBR2_HAS_SHEEN_ROUGH_TEX = 1 << 29;

const SHEEN_HELPERS = `
fn normalDistributionFunction_CharlieSheen(NdotH_sh: f32, alphaG_sh: f32) -> f32 {
let invR = 1.0 / alphaG_sh;
let cos2h = NdotH_sh * NdotH_sh;
let sin2h = 1.0 - cos2h;
return (2.0 + invR) * pow(sin2h, invR * 0.5) / (2.0 * 3.141592653589793);
}
fn visibility_Ashikhmin(NdotL_sh: f32, NdotV_sh: f32) -> f32 {
return 1.0 / (4.0 * (NdotL_sh + NdotV_sh - NdotL_sh * NdotV_sh));
}
`;

const SHEEN_DIRECT_MOD = (intensityExpr: string): string => `
{
let shIntensity = ${intensityExpr};
let shColorScaled = sheenColorFinal * shIntensity;
let shRoughness_clamped = max(sheenRoughnessAdjusted, AA_factor_x);
let shAlphaG = shRoughness_clamped * shRoughness_clamped + 0.0005;
let shD = normalDistributionFunction_CharlieSheen(NdotH, shAlphaG);
let shV = visibility_Ashikhmin(NdotL, NdotV);
sheenDirectTerm = shColorScaled * shD * shV * NdotL * lightColor * lightAtten * material.directIntensity;
}
`;

const SHEEN_IBL_MOD = (intensityExpr: string, albedoScaling: boolean): string => `
{
let shIntensity_ibl = ${intensityExpr};
let shColorScaled = sheenColorFinal * shIntensity_ibl;
let shRoughness_ibl = sheenRoughnessAdjusted;
let shAlphaG_ibl = shRoughness_ibl * shRoughness_ibl + 0.0005 + AA_factor_y;
var shSpecLod = log2(cubemapDim * shAlphaG_ibl) * scene.vImageInfos.z;
let shEnvRadiance = textureSampleLevel(iblTexture, iblSampler, R, clamp(shSpecLod, 0.0, maxLod)).rgb * material.environmentIntensity;
let shBrdf = textureSampleLevel(brdfLUT, brdfSampler_, vec2<f32>(NdotV, shRoughness_ibl), 0.0);
let shEnvReflectance = shColorScaled * shBrdf.b${albedoScaling ? " * seo * eho" : ""};
sheenIblTerm = shEnvRadiance * shEnvReflectance;
${albedoScaling ? "let shMax = max(shColorScaled.r, max(shColorScaled.g, shColorScaled.b));\nsheenAlbedoScaling = 1.0 - shMax * shBrdf.b;" : ""}
}
`;

const SHEEN_IBL_COLOR_MOD = (albedoScaling: boolean): string =>
    albedoScaling
        ? `
{
color = (finalIrradiance
      + finalRadianceScaled
      + finalSpecularScaled
      + directDiffuse) * sheenAlbedoScaling
      + sheenDirectTerm
      + sheenIblTerm
      + emissive;
}
`
        : `
{
color = finalIrradiance
      + finalRadianceScaled
      + finalSpecularScaled
      + directDiffuse
      + sheenDirectTerm
      + sheenIblTerm
      + emissive;
}
`;

const SHEEN_NON_IBL_MOD = `
{
color = color + sheenDirectTerm;
}
`;

/**
 * Create a sheen fragment.
 * @param hasSheenTexture - Whether the material has a sheen texture.
 * @param hasIbl - Whether IBL is active for this pipeline.
 * @param hasAlbedoScaling - When true, uses BJS-spec sheen math (no F0 attenuation,
 *   proper base-layer albedo scaling, treats sheen texture as linear — upload
 *   as sRGB so the sampler does the conversion). When false (legacy), applies
 *   pow(rgb, 2.2) to the texture and uses (1-F0) as the sheen intensity scalar.
 */
export function createSheenFragment(
    hasSheenTexture: boolean,
    hasIbl: boolean = false,
    hasAlbedoScaling: boolean = false,
    hasSheenUvTx: boolean = false,
    hasSheenRoughTex: boolean = false
): ShaderFragment {
    let scopeVars = `var sheenDirectTerm = vec3<f32>(0.0);
var sheenIblTerm = vec3<f32>(0.0);
var sheenAlbedoScaling = 1.0;
var sheenColorFinal = material.sheenParams.rgb;
var sheenRoughnessAdjusted = material.sheenParams2.x;`;
    if (hasSheenTexture) {
        const gammaStmt = hasAlbedoScaling ? "sheenMapData.rgb" : "pow(sheenMapData.rgb, vec3<f32>(2.2))";
        const sheenUvDecl = hasSheenUvTx
            ? "let sheenUV = vec2<f32>(dot(material.sheenUVm.xy, input.uv), dot(material.sheenUVm.zw, input.uv)) + material.sheenUVt.xy;"
            : "let sheenUV = input.uv;";
        // Roughness from the colour texture's alpha only when there is no distinct
        // sheenRoughnessTexture (BJS useRoughnessFromMainTexture); otherwise it is read below.
        const roughFromColor = hasSheenRoughTex ? "" : "\nsheenRoughnessAdjusted *= sheenMapData.a;";
        scopeVars += `
{
${sheenUvDecl}
let sheenMapData = textureSample(sheenTexture_, sheenSampler_, sheenUV);
sheenColorFinal *= ${gammaStmt};${roughFromColor}
}`;
    }
    if (hasSheenRoughTex) {
        // Distinct sheenRoughnessTexture: roughness from its A channel at its own animatable UV.
        scopeVars += `
{
let sheenRoughUV = vec2<f32>(dot(material.sheenRoughUVm.xy, input.uv), dot(material.sheenRoughUVm.zw, input.uv)) + material.sheenRoughUVt.xy;
sheenRoughnessAdjusted *= textureSample(sheenRoughTexture_, sheenRoughSampler_, sheenRoughUV).a;
}`;
    }

    const intensityExpr = hasAlbedoScaling ? "material.sheenParams.a" : "material.sheenParams.a * (1.0 - dielectricF0)";
    const slots: Partial<Record<string, string>> = {
        SV: scopeVars,
        AD: SHEEN_DIRECT_MOD(intensityExpr),
    };
    // AI and NI are mutually exclusive — only one path runs
    if (hasIbl) {
        slots.AI = SHEEN_IBL_MOD(intensityExpr, hasAlbedoScaling) + SHEEN_IBL_COLOR_MOD(hasAlbedoScaling);
    } else {
        slots.NI = SHEEN_NON_IBL_MOD;
    }

    const bindings: BindingDecl[] = [];
    if (hasSheenTexture) {
        bindings.push(
            { _name: "sheenTexture_", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "sheenSampler_", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT }
        );
    }
    if (hasSheenRoughTex) {
        bindings.push(
            { _name: "sheenRoughTexture_", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "sheenRoughSampler_", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT }
        );
    }

    const uboFields: UboField[] = [
        { _name: "sheenParams", _type: "vec4<f32>" },
        { _name: "sheenParams2", _type: "vec4<f32>" },
    ];
    if (hasSheenUvTx) {
        uboFields.push({ _name: "sheenUVm", _type: "vec4<f32>" }, { _name: "sheenUVt", _type: "vec4<f32>" });
    }
    if (hasSheenRoughTex) {
        uboFields.push({ _name: "sheenRoughUVm", _type: "vec4<f32>" }, { _name: "sheenRoughUVt", _type: "vec4<f32>" });
    }

    return {
        _id: "sheen",
        _dependencies: hasIbl ? ["ibl"] : undefined,

        _uboFields: uboFields,

        _bindings: bindings,

        _helperFunctions: SHEEN_HELPERS,

        _fragmentSlots: slots,
    };
}

/** Write the sheen material-UBO slice (sheenParams, sheenParams2, optional UV transform). */
export function writeSheenUBO(data: Float32Array, material: PbrMaterialProps, offsets: ReadonlyMap<string, number>): void {
    const sh = material.sheen as SheenProps | undefined;
    if (!sh?.isEnabled || !offsets.has("sheenParams")) {
        return;
    }
    const off = offsets.get("sheenParams")! / 4;
    const color = sh.color ?? [1, 1, 1];
    data[off] = color[0]!;
    data[off + 1] = color[1]!;
    data[off + 2] = color[2]!;
    data[off + 3] = sh.intensity ?? 1.0;
    data[off + 4] = sh.roughness ?? 0.0;
    data[off + 5] = sh.texture ? 1.0 : 0.0;

    // Optional per-texture UV transforms (KHR_texture_transform), each animatable.
    writeSheenUvTransform(data, offsets, "sheenUVm", "sheenUVt", sh.texture);
    writeSheenUvTransform(data, offsets, "sheenRoughUVm", "sheenRoughUVt", sh.roughnessTexture);
}

function writeSheenUvTransform(
    data: Float32Array,
    offsets: ReadonlyMap<string, number>,
    mName: string,
    tName: string,
    tex: { uScale?: number; vScale?: number; uAng?: number; uOffset?: number; vOffset?: number } | undefined
): void {
    const mOff = offsets.get(mName);
    const tOff = offsets.get(tName);
    if (mOff === undefined || tOff === undefined) {
        return;
    }
    const sx = tex?.uScale ?? 1;
    const sy = tex?.vScale ?? 1;
    const ang = tex?.uAng ?? 0;
    const mi = mOff / 4;
    const ti = tOff / 4;
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
    data[ti] = tex?.uOffset ?? 0;
    data[ti + 1] = tex?.vOffset ?? 0;
    data[ti + 2] = 0;
    data[ti + 3] = 0;
}

export const pbrExt: PbrExt = {
    id: "sheen",
    phase: "base-tex",
    detect(mat) {
        const sh = (mat as PbrMaterialProps).sheen as SheenProps | undefined;
        if (!sh?.isEnabled) {
            return { f: 0, f2: 0 };
        }
        let f = PBR_HAS_SHEEN;
        let f2 = 0;
        if (sh.texture) {
            f |= PBR_HAS_SHEEN_TEXTURE;
            if ((sh.texture as { _hasTx?: boolean })._hasTx) {
                f2 |= PBR2_HAS_SHEEN_UV_TX;
            }
        }
        if (sh.roughnessTexture) {
            f2 |= PBR2_HAS_SHEEN_ROUGH_TEX;
        }
        if (sh.albedoScaling) {
            f |= PBR_HAS_SHEEN_ALBEDO_SCALING;
        }
        return { f, f2 };
    },
    frag(ctx) {
        if (!(ctx._features & PBR_HAS_SHEEN)) {
            return null;
        }
        return createSheenFragment(
            (ctx._features & PBR_HAS_SHEEN_TEXTURE) !== 0,
            ctx._hasIbl,
            (ctx._features & PBR_HAS_SHEEN_ALBEDO_SCALING) !== 0,
            (ctx._features2 & PBR2_HAS_SHEEN_UV_TX) !== 0,
            (ctx._features2 & PBR2_HAS_SHEEN_ROUGH_TEX) !== 0
        );
    },
    writeUbo: writeSheenUBO as PbrExt["writeUbo"],
    bind(ctx, entries, b) {
        const sh = (ctx._material as PbrMaterialProps).sheen as SheenProps | undefined;
        if ((ctx._features & PBR_HAS_SHEEN_TEXTURE) !== 0 && sh?.texture) {
            entries.push({ binding: b++, resource: sh.texture.view });
            entries.push({ binding: b++, resource: sh.texture.sampler });
        }
        if ((ctx._features2 & PBR2_HAS_SHEEN_ROUGH_TEX) !== 0 && sh?.roughnessTexture) {
            entries.push({ binding: b++, resource: sh.roughnessTexture.view });
            entries.push({ binding: b++, resource: sh.roughnessTexture.sampler });
        }
        return b;
    },
    textures(mat, out) {
        const sh = (mat as PbrMaterialProps).sheen;
        if (sh?.texture) {
            out.push(sh.texture);
        }
        if (sh?.roughnessTexture) {
            out.push(sh.roughnessTexture);
        }
    },
};
