/**
 * Anisotropy PBR Template Extension
 *
 * Provides WGSL strings for anisotropic BRDF and tangent frame computation.
 * Dynamically imported only when a scene uses PBR anisotropy, keeping
 * non-anisotropy PBR bundles lean.
 */

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
let anisoDir = normalize(vec2<f32>(mesh.anisotropyParams.y, mesh.anisotropyParams.z));
anisoT = normalize(anisoT * anisoDir.x + anisoB * anisoDir.y);
anisoB = normalize(cross(N, anisoT));
}`;
    }
    // Derive tangent frame geometrically (cross with up vector)
    return `var anisoT: vec3<f32>;
var anisoB: vec3<f32>;
{
var aniso_t_raw = cross(vec3<f32>(0.0, 1.0, 0.0), N);
if (dot(aniso_t_raw, aniso_t_raw) < 0.001) {
aniso_t_raw = cross(vec3<f32>(1.0, 0.0, 0.0), N);
}
let anisoDir = normalize(vec2<f32>(mesh.anisotropyParams.y, mesh.anisotropyParams.z));
let rawT = normalize(aniso_t_raw);
let rawB = normalize(cross(N, rawT));
anisoT = normalize(rawT * anisoDir.x + rawB * anisoDir.y);
anisoB = normalize(cross(N, anisoT));
}`;
}

/** Anisotropic D/G replacement for single-light direct lighting. */
export const ANISO_DIRECT_DG = `let aniso_alphaTB = getAnisotropicRoughness(directAlphaG, mesh.anisotropyParams.x);
let dl_TdotH = dot(anisoT, H); let dl_BdotH = dot(anisoB, H);
let dl_TdotV = dot(anisoT, V); let dl_BdotV = dot(anisoB, V);
let dl_TdotL = dot(anisoT, L); let dl_BdotL = dot(anisoB, L);
let D = D_GGX_Anisotropic(NdotH, dl_TdotH, dl_BdotH, aniso_alphaTB);
let G = V_GGXCorrelated_Anisotropic(NdotL, NdotV, dl_TdotV, dl_BdotV, dl_TdotL, dl_BdotL, aniso_alphaTB);`;

/** IBL bent normal computation for anisotropic reflection. */
export const ANISO_BENT_NORMAL = `let anisoIntensity = mesh.anisotropyParams.x;
var anisoBentNormal = cross(anisoB, V);
anisoBentNormal = normalize(cross(anisoBentNormal, anisoB));
let anisoSq = 1.0 - anisoIntensity * (1.0 - roughness);
let anisoA = anisoSq * anisoSq * anisoSq * anisoSq;
anisoBentNormal = normalize(mix(anisoBentNormal, N, anisoA));
let R_raw = reflect(-V, anisoBentNormal);`;
