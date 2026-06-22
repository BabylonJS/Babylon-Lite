/**
 * Anisotropy PBR Template Extension
 *
 * Provides WGSL strings for anisotropic BRDF and tangent frame computation.
 * Dynamically imported only when a scene uses PBR anisotropy, keeping
 * non-anisotropy PBR bundles lean.
 */

import type { ShaderFragment, BindingDecl, UboField } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";

const STAGE_FRAGMENT = 0x2;

// Extension-local features2 bit (reserved as 1<<27 in pbr-flag-bits.ts). Defined here
// — not in the shared flag module — so scenes that never load this lazy fragment carry
// zero bytes for it. Set when the material has a KHR_materials_anisotropy anisotropyTexture
// (per-texel direction RG + strength B). Always pairs anisotropyUVm/anisotropyUVt so an
// animated KHR_texture_transform on the texture is honoured.
const PBR2_HAS_ANISO_TEX = 1 << 27;
export { PBR2_HAS_ANISO_TEX };

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

/** Generate anisotropy tangent/bitangent computation block for the given normal mode.
 *  Declares function-scope `anisoIntensityF` (used by direct DG + IBL bent normal). When
 *  `hasTexture`, samples the anisotropyTexture for per-texel direction (RG) and strength (B)
 *  per KHR_materials_anisotropy: dir = rotate(normalize(tex.rg*2-1), materialDir); strength *= tex.b. */
export function makeAnisotropyTBBlock(hasNormal: boolean, hasTexture: boolean = false): string {
    const texSample = hasTexture
        ? `let anisoUV = vec2<f32>(dot(material.anisotropyUVm.xy, input.uv), dot(material.anisotropyUVm.zw, input.uv)) + material.anisotropyUVt.xy;
let anisoTexData = textureSample(anisotropyTexture_, anisotropySampler_, anisoUV).rgb;
anisoIntensityF = anisoIntensityF * anisoTexData.b;
let anisoNdir = normalize(anisoTexData.rg * 2.0 - vec2<f32>(1.0));
anisoDir2 = vec2<f32>(anisoDir2.x * anisoNdir.x - anisoDir2.y * anisoNdir.y, anisoDir2.y * anisoNdir.x + anisoDir2.x * anisoNdir.y);
`
        : "";
    const pre = `var anisoIntensityF = material.anisotropyParams.x;
var anisoDir2 = vec2<f32>(material.anisotropyParams.y, material.anisotropyParams.z);
${texSample}`;
    if (hasNormal) {
        return `${pre}var anisoT = normalize(input.worldTangent);
var anisoB = normalize(input.worldBitangent);
{
let anisoDir = normalize(anisoDir2);
anisoT = normalize(anisoT * anisoDir.x + anisoB * anisoDir.y);
anisoB = normalize(cross(N, anisoT));
}`;
    }
    // Cotangent frame from UV screen-space derivatives. Must be built IDENTICALLY to the
    // normal-map cotangent frame in pbr-template.ts (geometric normal, +dpdy, negated
    // bitangent) so the anisotropy tangent agrees with BJS, which derives the anisotropy
    // T/B from the same TBN used for normal mapping. The shading normal N is used only for
    // the third column (matching BJS `mat3(normalize(TBN[0]),normalize(TBN[1]),normalize(N))`).
    return `${pre}var anisoT: vec3<f32>;
var anisoB: vec3<f32>;
{
let aniso_Ngeom = normalize(input.worldNormal);
let aniso_dp1 = dpdx(input.worldPos);
let aniso_dp2 = dpdy(input.worldPos);
let aniso_duv1 = dpdx(input.uv);
let aniso_duv2 = dpdy(input.uv);
let aniso_dp2perp = cross(aniso_dp2, aniso_Ngeom);
let aniso_dp1perp = cross(aniso_Ngeom, aniso_dp1);
let aniso_tct = aniso_dp2perp * aniso_duv1.x + aniso_dp1perp * aniso_duv2.x;
let aniso_bct = -(aniso_dp2perp * aniso_duv1.y + aniso_dp1perp * aniso_duv2.y);
let aniso_det = max(dot(aniso_tct, aniso_tct), dot(aniso_bct, aniso_bct));
let aniso_inv = select(inverseSqrt(aniso_det), 0.0, aniso_det == 0.0);
let anisoTBN = mat3x3<f32>(normalize(aniso_tct * aniso_inv), normalize(aniso_bct * aniso_inv), N);
let anisoDir = vec3<f32>(anisoDir2.x, anisoDir2.y, 0.0);
anisoT = normalize(anisoTBN * anisoDir);
anisoB = normalize(cross(anisoTBN[2], anisoT));
}`;
}

/** Anisotropic D/G replacement for single-light direct lighting. */
export const ANISO_DIRECT_DG = `let aniso_alphaTB = getAnisotropicRoughness(directAlphaG, anisoIntensityF);
let dl_TdotH = dot(anisoT, H); let dl_BdotH = dot(anisoB, H);
let dl_TdotV = dot(anisoT, V); let dl_BdotV = dot(anisoB, V);
let dl_TdotL = dot(anisoT, L); let dl_BdotL = dot(anisoB, L);
let D = D_GGX_Anisotropic(NdotH, dl_TdotH, dl_BdotH, aniso_alphaTB);
let G = V_GGXCorrelated_Anisotropic(NdotL, NdotV, dl_TdotV, dl_BdotV, dl_TdotL, dl_BdotL, aniso_alphaTB);`;

/** IBL bent normal computation for anisotropic reflection. */
export const ANISO_BENT_NORMAL = `var anisoBentNormal = cross(anisoB, V);
anisoBentNormal = normalize(cross(anisoBentNormal, anisoB));
let anisoSq = 1.0 - anisoIntensityF * (1.0 - roughness);
let anisoA = anisoSq * anisoSq * anisoSq * anisoSq;
anisoBentNormal = normalize(mix(anisoBentNormal, N, anisoA));
let R_raw = reflect(-V, anisoBentNormal);`;

/** Anisotropy extension. Writes its material-UBO slice (anisotropyParams, and when an
 *  anisotropyTexture is present, anisotropyUVm/anisotropyUVt) and — only for the textured
 *  case — contributes the texture binding + UV-transform UBO fields via `frag()`. The
 *  anisotropic BRDF / tangent-frame WGSL is injected through the template strings above. */
export const pbrExt: PbrExt = {
    id: "anisotropy",
    phase: "fragment",
    detect(mat) {
        const aniso = (mat as PbrMaterialProps).anisotropy;
        return { f: 0, f2: aniso?.isEnabled && aniso.texture ? PBR2_HAS_ANISO_TEX : 0 };
    },
    frag(ctx) {
        if ((ctx._features2 & PBR2_HAS_ANISO_TEX) === 0) {
            return null;
        }
        const bindings: BindingDecl[] = [
            { _name: "anisotropyTexture_", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "anisotropySampler_", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT },
        ];
        const uboFields: UboField[] = [
            { _name: "anisotropyUVm", _type: "vec4<f32>" },
            { _name: "anisotropyUVt", _type: "vec4<f32>" },
        ];
        const frag: ShaderFragment = { _id: "anisotropy-tex", _bindings: bindings, _uboFields: uboFields };
        return frag;
    },
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

        // Per-texture UV transform (KHR_texture_transform on anisotropyTexture), animatable.
        const mOff = offsets.get("anisotropyUVm");
        const tOff = offsets.get("anisotropyUVt");
        if (mOff === undefined || tOff === undefined) {
            return;
        }
        const tex = aniso.texture;
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
    },
    bind(ctx, entries, b) {
        const aniso = (ctx._material as PbrMaterialProps).anisotropy;
        if ((ctx._features2 & PBR2_HAS_ANISO_TEX) === 0 || !aniso?.texture) {
            return b;
        }
        entries.push({ binding: b++, resource: aniso.texture.view });
        entries.push({ binding: b++, resource: aniso.texture.sampler });
        return b;
    },
    textures(mat, out) {
        const aniso = (mat as PbrMaterialProps).anisotropy;
        if (aniso?.texture) {
            out.push(aniso.texture);
        }
    },
};
