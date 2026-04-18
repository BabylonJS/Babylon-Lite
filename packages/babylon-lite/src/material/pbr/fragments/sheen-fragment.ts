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

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps, SheenProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_SHEEN, PBR_HAS_SHEEN_TEXTURE, PBR_HAS_SHEEN_ALBEDO_SCALING } from "../pbr-flags.js";

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

const SHEEN_DIRECT_MOD_NEW = `
{
let shIntensity = material.sheenParams.a;
let shColorScaled = sheenColorFinal * shIntensity;
let shRoughness_clamped = max(sheenRoughnessAdjusted, AA_factor_x);
let shAlphaG = shRoughness_clamped * shRoughness_clamped + 0.0005;
let shD = normalDistributionFunction_CharlieSheen(NdotH, shAlphaG);
let shV = visibility_Ashikhmin(NdotL, NdotV);
sheenDirectTerm = shColorScaled * shD * shV * NdotL * lightColor * lightAtten * material.directIntensity;
}
`;

const SHEEN_IBL_MOD_NEW = `
{
let shIntensity_ibl = material.sheenParams.a;
let shColorScaled = sheenColorFinal * shIntensity_ibl;
let shRoughness_ibl = sheenRoughnessAdjusted;
let shAlphaG_ibl = shRoughness_ibl * shRoughness_ibl + 0.0005 + AA_factor_y;
var shSpecLod = log2(cubemapDim * shAlphaG_ibl) * scene.lodGenerationScale;
let shEnvRadiance = textureSampleLevel(iblTexture, iblSampler, R, clamp(shSpecLod, 0.0, maxLod)).rgb * material.environmentIntensity;
let shBrdf = textureSampleLevel(brdfLUT, brdfSampler_, vec2<f32>(NdotV, shRoughness_ibl), 0.0);
let shEnvReflectance = shColorScaled * shBrdf.b;
sheenIblTerm = shEnvRadiance * shEnvReflectance;
let shMax = max(shColorScaled.r, max(shColorScaled.g, shColorScaled.b));
sheenAlbedoScaling = 1.0 - shMax * shBrdf.b;
}
`;

const SHEEN_IBL_COLOR_MOD_NEW = `
{
color = (finalIrradiance
      + finalRadianceScaled
      + finalSpecularScaled
      + directDiffuse) * sheenAlbedoScaling
      + sheenDirectTerm
      + sheenIblTerm
      + emissive;
}
`;

const SHEEN_DIRECT_MOD_LEGACY = `
{
let shColor = sheenColorFinal;
let shIntensity = material.sheenParams.a * (1.0 - dielectricF0);
let shRoughness_clamped = max(sheenRoughnessAdjusted, AA_factor_x);
let shColorScaled = shColor * shIntensity;
let shAlphaG = shRoughness_clamped * shRoughness_clamped + 0.0005;
let shD = normalDistributionFunction_CharlieSheen(NdotH, shAlphaG);
let shV = visibility_Ashikhmin(NdotL, NdotV);
sheenDirectTerm = shColorScaled * shD * shV * NdotL * lightColor * lightAtten * material.directIntensity;
}
`;

const SHEEN_IBL_MOD_LEGACY = `
{
let shColor_ibl = sheenColorFinal;
let shIntensity_ibl = material.sheenParams.a * (1.0 - dielectricF0);
let shRoughness_ibl = sheenRoughnessAdjusted;
let shAlphaG_ibl = shRoughness_ibl * shRoughness_ibl + 0.0005 + AA_factor_y;
var shSpecLod = log2(cubemapDim * shAlphaG_ibl) * scene.lodGenerationScale;
let shEnvRadiance = textureSampleLevel(iblTexture, iblSampler, R, clamp(shSpecLod, 0.0, maxLod)).rgb * material.environmentIntensity;
let shBrdf = textureSampleLevel(brdfLUT, brdfSampler_, vec2<f32>(NdotV, shRoughness_ibl), 0.0);
let shColorScaled = shColor_ibl * shIntensity_ibl;
let shEnvReflectance = shColorScaled * shBrdf.b;
sheenIblTerm = shEnvRadiance * shEnvReflectance;
}
`;

const SHEEN_IBL_COLOR_MOD_LEGACY = `
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
 * @param hasSheenTexture Whether the material has a sheen texture.
 * @param hasIbl Whether IBL is active for this pipeline.
 * @param hasAlbedoScaling When true, uses BJS-spec sheen math (no F0 attenuation,
 *   proper base-layer albedo scaling, treats sheen texture as linear — upload
 *   as sRGB so the sampler does the conversion). When false (legacy), applies
 *   pow(rgb, 2.2) to the texture and uses (1-F0) as the sheen intensity scalar.
 */
export function createSheenFragment(hasSheenTexture: boolean, hasIbl: boolean = false, hasAlbedoScaling: boolean = false): ShaderFragment {
    let scopeVars = `var sheenDirectTerm = vec3<f32>(0.0);
var sheenIblTerm = vec3<f32>(0.0);
var sheenAlbedoScaling = 1.0;
var sheenColorFinal = material.sheenParams.rgb;
var sheenRoughnessAdjusted = material.sheenParams2.x;`;
    if (hasSheenTexture) {
        const gammaStmt = hasAlbedoScaling ? "sheenMapData.rgb" : "pow(sheenMapData.rgb, vec3<f32>(2.2))";
        scopeVars += `
{
let sheenMapData = textureSample(sheenTexture_, sheenSampler_, input.uv);
sheenColorFinal *= ${gammaStmt};
sheenRoughnessAdjusted *= sheenMapData.a;
}`;
    }

    const slots: Partial<Record<string, string>> = {
        SV: scopeVars,
        AD: hasAlbedoScaling ? SHEEN_DIRECT_MOD_NEW : SHEEN_DIRECT_MOD_LEGACY,
    };
    // AI and NI are mutually exclusive — only one path runs
    if (hasIbl) {
        slots.AI = hasAlbedoScaling ? SHEEN_IBL_MOD_NEW + SHEEN_IBL_COLOR_MOD_NEW : SHEEN_IBL_MOD_LEGACY + SHEEN_IBL_COLOR_MOD_LEGACY;
    } else {
        slots.NI = SHEEN_NON_IBL_MOD;
    }

    return {
        id: "sheen",
        dependencies: hasIbl ? ["ibl"] : undefined,

        // UBO fields are in the PBR template's baseMeshUboFields for byte-layout compat.

        helperFunctions: SHEEN_HELPERS,

        fragmentSlots: slots,
    };
}

/** Write the sheen material-UBO slice (sheenParams). */
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
}

export const sheenExt: PbrExt = {
    id: "sheen",
    phase: "base-tex",
    detect(mat) {
        const sh = (mat as PbrMaterialProps).sheen as SheenProps | undefined;
        if (!sh?.isEnabled) {
            return { f: 0, f2: 0 };
        }
        let f = PBR_HAS_SHEEN;
        if (sh.texture) {
            f |= PBR_HAS_SHEEN_TEXTURE;
        }
        if (sh.albedoScaling) {
            f |= PBR_HAS_SHEEN_ALBEDO_SCALING;
        }
        return { f, f2: 0 };
    },
    frag(ctx) {
        if (!(ctx.features & PBR_HAS_SHEEN)) {
            return null;
        }
        return createSheenFragment((ctx.features & PBR_HAS_SHEEN_TEXTURE) !== 0, ctx.hasIbl, (ctx.features & PBR_HAS_SHEEN_ALBEDO_SCALING) !== 0);
    },
    writeUbo: writeSheenUBO as PbrExt["writeUbo"],
    textures(mat, out) {
        const sh = (mat as PbrMaterialProps).sheen;
        if (sh?.texture) {
            out.push(sh.texture);
        }
    },
};
