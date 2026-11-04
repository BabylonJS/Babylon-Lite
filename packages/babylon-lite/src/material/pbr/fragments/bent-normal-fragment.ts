/**
 * Bent Normal Fragment
 *
 * Bent-normal reflection occlusion for IBL. Explicit opt-in via `enableBentNormals()`,
 * so only bundled when a scene imports it.
 *
 * Math follows BJS PBRMaterial BENTNORMAL (spherical-Gaussian visibility cone):
 *  - Bent normal sampled from a tangent-space map and transformed with the vertex
 *    TBN when it is compatible, else a screen-space cotangent frame built from the
 *    geometric normal (same convention as the base normal map).
 *  - The environment specular radiance is multiplied by the ratio of the visibility
 *    cone/reflection-lobe SG overlap to the open-hemisphere overlap. The analytic
 *    specular occlusion (seo) is dropped in that case (see patchIblCalculation).
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_DOUBLE_SIDED, PBR_HAS_NORMAL_MAP, PBR2_HAS_BENT_NORMAL } from "../pbr-flag-bits.js";
import { MSH_HAS_TANGENTS, MSH_HAS_THIN_INSTANCES } from "../../mesh-features.js";
import { pbrExt as iblExt } from "./ibl-fragment.js";

const STAGE_FRAGMENT = 0x2;

// Spherical Gaussians parameterized by spread = 1/sharpness. See BJS pbrIBLFunctions.fx (BENTNORMAL).
const BENT_NORMAL_HELPERS = `
fn bentNormalSGOverlap(d2in:f32,spread:f32,rs:f32)->f32{
let d2=clamp(d2in,0.0,4.0);let sp=spread*rs;let sd=spread-rs;
let pl=sqrt(sd*sd+sp*(4.0-d2));let e=-d2/max(pl+spread+rs,1e-30);let x=2.0*pl/max(sp,1e-30);
var o=spread*(1.0-exp(-x))/max(pl,1e-30);
if(x<0.01){o=2.0*spread/max(sp,1e-30)*(1.0-x*(0.5-x/6.0));}
return exp(e)*o;}
fn bentNormalSGOcclusion(bd2:f32,nd2:f32,NdotV:f32,ao:f32,alphaG:f32)->f32{
let v=saturate(ao);let cc=sqrt(1.0-v);let vs=v/(1.0+cc);let rs=2.0*alphaG*alphaG*saturate(NdotV);
return min(1.0,bentNormalSGOverlap(bd2,vs,rs)/bentNormalSGOverlap(nd2,1.0,rs));}
fn environmentBentNormalOcclusion(bent:vec3<f32>,R:vec3<f32>,n:vec3<f32>,NdotV:f32,ao:f32,alphaG:f32)->f32{
let v=saturate(ao);if(v==0.0||v==1.0){return v;}
let cs=sqrt(v);let c=dot(bent,n);var axis=bent;
if(c<cs){let t=bent-c*n;let tl=length(t);axis=n;if(tl>1e-6){axis=cs*n+sqrt(1.0-v)*t/tl;}}
let bd=axis-R;let nd=n-R;
return bentNormalSGOcclusion(dot(bd,bd),dot(nd,nd),NdotV,v,alphaG);}
`;

/**
 * Create the bent-normal fragment.
 * @param reuseTbn - Reuse the template's vertex `TBN` (tangent normal mode, no thin instances).
 * @param doubleSided - Material is double-sided (`frontFacing` is in scope).
 */
export function createBentNormalFragment(reuseTbn: boolean, doubleSided: boolean): ShaderFragment {
    const frame = reuseTbn
        ? "let bnTBN=TBN;"
        : `let bnUV=${doubleSided ? "select(-input.uv,input.uv,frontFacing)" : "input.uv"};
let bnDp1=dpdx(input.worldPos);let bnDp2=dpdy(input.worldPos);let bnDuv1=dpdx(bnUV);let bnDuv2=dpdy(bnUV);
let bnDp2p=cross(bnDp2,N_geom);let bnDp1p=cross(N_geom,bnDp1);
let bnT=bnDp2p*bnDuv1.x+bnDp1p*bnDuv2.x;let bnB=-(bnDp2p*bnDuv1.y+bnDp1p*bnDuv2.y);
let bnDet=max(dot(bnT,bnT),dot(bnB,bnB));let bnInv=select(inverseSqrt(bnDet),0.0,bnDet==0.0);
let bnTBN=mat3x3<f32>(bnT*bnInv,bnB*bnInv,N_geom);`;
    return {
        _id: "bent-normal",
        // vec4 keeps the 16-byte packing later fragments (e.g. reflectance) rely on; strength in .x.
        _uboFields: [{ _name: "bentNormalParams", _type: "vec4<f32>" }],
        _bindings: [
            { _name: "bentNormalTexture_", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "bentNormalSampler_", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT },
        ],
        _helperFunctions: BENT_NORMAL_HELPERS,
        _fragmentSlots: {
            AC: `${frame}
var bentNormalW=normalize(bnTBN*(textureSample(bentNormalTexture_,bentNormalSampler_,input.uv).rgb*2.0-1.0));
${doubleSided ? "if(!frontFacing){bentNormalW=-bentNormalW;}" : ""}
let bentNormalStrength=saturate(material.bentNormalParams.x);`,
        },
    };
}

/**
 * Patch the IBL calculation for bent normals (BJS: `RADIANCEOCCLUSION && !BENTNORMAL`
 * drops `seo` from colorSpecularEnvironmentReflectance, then finalRadiance is scaled by
 * the SG cone occlusion). The search strings are template literals so the bundle WGSL
 * minifier rewrites them exactly like the IBL source. Skybox materials never get here
 * (gated in `detect`).
 */
function patchIblCalculation(ai: string): string {
    return ai
        .replace(`specularEnvironmentReflectance * seo * eho`, `specularEnvironmentReflectance * eho`)
        .replace(
            `colorSpecularEnvReflectance * energyConservation`,
            `colorSpecularEnvReflectance * mix(1.0, environmentBentNormalOcclusion(bentNormalW, R_raw, N, NdotVUnclamped, occlusion, alphaG), bentNormalStrength) * energyConservation`
        );
}

/**
 * Enable bent-normal reflection occlusion (`PbrMaterialProps.bentNormalTexture`).
 *
 * Explicit opt-in so scenes without bent normals carry zero bent-normal bytes: nothing
 * in the always-fetched engine graph references this module. It installs the bent-normal
 * hooks onto the IBL extension (merging into the IBL fragment), so the pre-existing
 * IBL registration in the PBR build picks them up. Idempotent and global.
 *
 * Call BEFORE `registerScene(scene)` (or before any PBR material is first built).
 * Requires an environment (IBL); materials also need an ambient occlusion texture
 * (`ormTexture` or `occlusionTexture`), matching Babylon.js.
 *
 * @example
 * ```ts
 * mat.bentNormalTexture = await loadTexture2D(engine, url, { invertY: false });
 * enableBentNormals();
 * await registerScene(scene);
 * ```
 */
export function enableBentNormals(): void {
    const ext = iblExt as { -readonly [K in keyof PbrExt]: PbrExt[K] };
    // The IBL ext has no `detect` of its own, so its presence marks installation.
    if (ext.detect) {
        return;
    }
    const iblFrag = ext.frag!;
    const iblBind = ext.bind!;
    ext.detect = (mat) => {
        const m = mat as PbrMaterialProps;
        // BJS gates BENTNORMAL on a lit material with an ambient occlusion texture. Skybox
        // materials use a different IBL path with no specular occlusion to attenuate.
        return {
            f: 0,
            f2: m.bentNormalTexture && !m.unlit && !m.skyboxMode && (m.ormTexture || m.occlusionTexture) && (m.occlusionStrength ?? 1) > 0 ? PBR2_HAS_BENT_NORMAL : 0,
        };
    };
    ext.frag = (ctx) => {
        const ibl = iblFrag(ctx);
        if (!ibl || !(ctx._features2 & PBR2_HAS_BENT_NORMAL)) {
            return ibl;
        }
        const reuseTbn = (ctx._features & PBR_HAS_NORMAL_MAP) !== 0 && (ctx._meshFeatures & MSH_HAS_TANGENTS) !== 0 && (ctx._meshFeatures & MSH_HAS_THIN_INSTANCES) === 0;
        const bent = createBentNormalFragment(reuseTbn, (ctx._features & PBR_HAS_DOUBLE_SIDED) !== 0);
        return {
            ...ibl,
            _uboFields: bent._uboFields,
            _bindings: [...ibl._bindings!, ...bent._bindings!],
            _helperFunctions: ibl._helperFunctions! + bent._helperFunctions!,
            _fragmentSlots: { ...ibl._fragmentSlots, ...bent._fragmentSlots, AI: patchIblCalculation(ibl._fragmentSlots!.AI!) },
        };
    };
    ext.writeUbo = (data, mat, offsets) => {
        const off = offsets.get("bentNormalParams");
        if (off !== undefined) {
            data[off / 4] = (mat as PbrMaterialProps).bentNormalStrength ?? 1;
        }
    };
    ext.bind = (ctx, entries, b) => {
        b = iblBind(ctx, entries, b);
        const t = (ctx._material as PbrMaterialProps).bentNormalTexture;
        // Bindings exist only in the bent variant of the fragment.
        if (t && ctx._env && ctx._features2 & PBR2_HAS_BENT_NORMAL) {
            entries.push({ binding: b++, resource: t.view });
            entries.push({ binding: b++, resource: t.sampler });
        }
        return b;
    };
    ext.textures = (mat, out) => {
        const t = (mat as PbrMaterialProps).bentNormalTexture;
        if (t) {
            out.push(t);
        }
    };
}
