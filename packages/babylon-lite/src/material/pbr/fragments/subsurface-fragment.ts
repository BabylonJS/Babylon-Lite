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

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps, SubSurfaceProps } from "../pbr-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_SUBSURFACE, PBR_HAS_THICKNESS_MAP } from "../pbr-flags.js";

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

// AT: sample thickness + compute transmittance (BJS non-glTF path samples .r channel)
function makeThicknessBlock(hasThicknessMap: boolean): string {
    const texSample = hasThicknessMap ? `let thicknessSample = textureSample(thicknessTexture_, thicknessSampler_, input.uv).r;` : `let thicknessSample = 1.0;`;
    return `${texSample}
let ssThickness = max(material.subsurfaceParams.y + thicknessSample * material.subsurfaceParams.z, 0.000001);
let ssTranslucencyColor = material.subsurfaceParams3.rgb;
let ssDiffDist = material.subsurfaceParams2.rgb;
ssIntensity = material.subsurfaceParams.x;
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
let envIrrBack = (scene.vSphericalL00
  + scene.vSphericalL1_1 * N_back.y + scene.vSphericalL10 * N_back.z + scene.vSphericalL11 * N_back.x
  + scene.vSphericalL2_2 * (N_back.y * N_back.x) + scene.vSphericalL2_1 * (N_back.y * N_back.z)
  + scene.vSphericalL20 * (3.0 * N_back.z * N_back.z - 1.0) + scene.vSphericalL21 * (N_back.z * N_back.x)
  + scene.vSphericalL22 * (N_back.x * N_back.x - N_back.y * N_back.y)) * material.environmentIntensity;
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
 * @param hasThicknessMap Whether the material has a thickness texture.
 * @param hasIbl Whether the scene has IBL.
 */
export function createSubsurfaceFragment(hasThicknessMap: boolean, hasIbl: boolean): ShaderFragment {
    const bindings = hasThicknessMap
        ? [
              { name: "thicknessTexture_", type: { kind: "texture" as const, textureType: "texture_2d<f32>" as const }, visibility: STAGE_FRAGMENT },
              { name: "thicknessSampler_", type: { kind: "sampler" as const, samplerType: "sampler" as const }, visibility: STAGE_FRAGMENT },
          ]
        : [];

    const slots: Partial<Record<string, string>> = {
        SV: SS_SCOPE_VARS,
        AT: makeThicknessBlock(hasThicknessMap),
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
        id: "subsurface",
        dependencies: deps.length > 0 ? deps : undefined,
        bindings: bindings.length > 0 ? bindings : undefined,
        uboFields: [
            { name: "subsurfaceParams", type: "vec4<f32>" as const },
            { name: "subsurfaceParams2", type: "vec4<f32>" as const },
            { name: "subsurfaceParams3", type: "vec4<f32>" as const },
        ],
        helperFunctions: SS_HELPERS,
        fragmentSlots: slots,
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
}

export const subsurfaceExt: PbrExt = {
    id: "subsurface",
    phase: "fragment",
    detect(mat) {
        const m = mat as PbrMaterialProps;
        if (!m.subsurface?.translucency) {
            return { f: 0, f2: 0 };
        }
        let f = PBR_HAS_SUBSURFACE;
        if (m.subsurface.thickness?.texture) {
            f |= PBR_HAS_THICKNESS_MAP;
        }
        return { f, f2: 0 };
    },
    frag(ctx) {
        if (!(ctx.features & PBR_HAS_SUBSURFACE)) {
            return null;
        }
        return createSubsurfaceFragment((ctx.features & PBR_HAS_THICKNESS_MAP) !== 0, ctx.hasIbl);
    },
    writeUbo(data, mat, offsets) {
        const m = mat as PbrMaterialProps;
        if (m.subsurface?.translucency && offsets.has("subsurfaceParams")) {
            writeSubsurfaceUBO(data, m.subsurface as SubSurfaceProps, offsets);
        }
    },
    bind(ctx, entries, b) {
        if ((ctx.features & PBR_HAS_THICKNESS_MAP) !== 0) {
            const tex = (ctx.material as PbrMaterialProps).subsurface?.thickness?.texture as Texture2D | undefined;
            if (tex) {
                entries.push({ binding: b++, resource: tex.view });
                entries.push({ binding: b++, resource: tex.sampler });
            }
        }
        return b;
    },
    textures(mat, out) {
        const t = (mat as PbrMaterialProps).subsurface?.thickness?.texture;
        if (t) {
            out.push(t);
        }
    },
};
