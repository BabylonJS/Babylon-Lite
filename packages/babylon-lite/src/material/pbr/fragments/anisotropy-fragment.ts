/**
 * Anisotropy PBR Template Extension
 *
 * Provides WGSL strings for anisotropic BRDF and tangent frame computation.
 * Dynamically imported only when a scene uses PBR anisotropy, keeping
 * non-anisotropy PBR bundles lean.
 */

import type { PbrMaterialProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";

export const ANISO_BRDF_FUNCTIONS = `
const RECIPROCAL_PI: f32 = 0.3183098861837907;
fn getAnisotropicRoughness(alphaG: f32, anisotropy: f32) -> vec2<f32> {
let aT = max(mix(alphaG, 1.0, anisotropy * anisotropy), 0.0005);
let aB = max(alphaG, 0.0005);
return vec2<f32>(aT, aB);
}
fn D_GGX_Anisotropic(NdotH: f32, TdotH: f32, BdotH: f32, alphaTB: vec2<f32>) -> f32 {
let a2 = alphaTB.x * alphaTB.y;
let v = vec3<f32>(alphaTB.y * TdotH, alphaTB.x * BdotH, a2 * NdotH);
let v2 = dot(v, v);
let w2 = a2 / v2;
return a2 * w2 * w2 * RECIPROCAL_PI;
}
fn V_GGXCorrelated_Anisotropic(NdotL: f32, NdotV: f32, TdotV: f32, BdotV: f32, TdotL: f32, BdotL: f32, alphaTB: vec2<f32>) -> f32 {
let lambdaV = NdotL * length(vec3<f32>(alphaTB.x * TdotV, alphaTB.y * BdotV, NdotV));
let lambdaL = NdotV * length(vec3<f32>(alphaTB.x * TdotL, alphaTB.y * BdotL, NdotL));
return 0.5 / (lambdaV + lambdaL);
}
`;

/** Generate anisotropy tangent/bitangent computation block for the given normal mode. */
export function makeAnisotropyTBBlock(hasNormal: boolean): string {
    if (hasNormal) {
        return `var anisoT = normalize(input.worldTangent);
var anisoB = normalize(input.worldBitangent);
{
let anisoDir = normalize(vec2<f32>(material.anisotropyParams.y, material.anisotropyParams.z));
anisoT = normalize(anisoT * anisoDir.x + anisoB * anisoDir.y);
anisoB = normalize(cross(N, anisoT));
}`;
    }
    // Cotangent frame from UV screen-space derivatives — matches BJS cotangent_frame()
    // BJS negates dpdy via (-yFactor_) where yFactor_=1 in WebGPU
    return `var anisoT: vec3<f32>;
var anisoB: vec3<f32>;
{
let aniso_dp1 = dpdx(input.worldPos);
let aniso_dp2 = -dpdy(input.worldPos);
let aniso_duv1 = dpdx(input.uv);
let aniso_duv2 = -dpdy(input.uv);
let aniso_dp2perp = cross(aniso_dp2, N);
let aniso_dp1perp = cross(N, aniso_dp1);
var aniso_t = aniso_dp2perp * aniso_duv1.x + aniso_dp1perp * aniso_duv2.x;
var aniso_b = aniso_dp2perp * aniso_duv1.y + aniso_dp1perp * aniso_duv2.y;
let aniso_det = max(dot(aniso_t, aniso_t), dot(aniso_b, aniso_b));
let aniso_inv = select(inverseSqrt(aniso_det), 0.0, aniso_det == 0.0);
aniso_t *= aniso_inv;
aniso_b *= aniso_inv;
let aniso_tn = normalize(aniso_t);
let aniso_bn = normalize(aniso_b);
let anisoTBN = mat3x3<f32>(aniso_tn, aniso_bn, N);
let anisoDir = vec3<f32>(material.anisotropyParams.y, material.anisotropyParams.z, 0.0);
anisoT = normalize(anisoTBN * anisoDir);
anisoB = normalize(cross(anisoTBN[2], anisoT));
}`;
}

/** Anisotropic D/G replacement for single-light direct lighting. */
export const ANISO_DIRECT_DG = `let aniso_alphaTB = getAnisotropicRoughness(directAlphaG, material.anisotropyParams.x);
let dl_TdotH = dot(anisoT, H); let dl_BdotH = dot(anisoB, H);
let dl_TdotV = dot(anisoT, V); let dl_BdotV = dot(anisoB, V);
let dl_TdotL = dot(anisoT, L); let dl_BdotL = dot(anisoB, L);
let D = D_GGX_Anisotropic(NdotH, dl_TdotH, dl_BdotH, aniso_alphaTB);
let G = V_GGXCorrelated_Anisotropic(NdotL, NdotV, dl_TdotV, dl_BdotV, dl_TdotL, dl_BdotL, aniso_alphaTB);`;

/** IBL bent normal computation for anisotropic reflection. */
export const ANISO_BENT_NORMAL = `let anisoIntensity = material.anisotropyParams.x;
var anisoBentNormal = cross(anisoB, V);
anisoBentNormal = normalize(cross(anisoBentNormal, anisoB));
let anisoSq = 1.0 - anisoIntensity * (1.0 - roughness);
let anisoA = anisoSq * anisoSq * anisoSq * anisoSq;
anisoBentNormal = normalize(mix(anisoBentNormal, N, anisoA));
let R_raw = reflect(-V, anisoBentNormal);`;

/** Anisotropy extension — template-only (contributes no ShaderFragment or bindings);
 *  present solely to write its material-UBO slice through the unified ext registry. */
export const pbrExt: PbrExt = {
    id: "anisotropy",
    phase: "fragment",
    writeUbo(data: Float32Array, material: unknown, offsets: ReadonlyMap<string, number>): void {
        const aniso = (material as PbrMaterialProps).anisotropy;
        if (!aniso?.isEnabled || !offsets.has("anisotropyParams")) {
            return;
        }
        const off = offsets.get("anisotropyParams")! / 4;
        const dir = aniso.direction ?? [1, 0];
        data[off] = aniso.intensity ?? 1.0;
        data[off + 1] = dir[0]!;
        data[off + 2] = dir[1]!;
    },
};
