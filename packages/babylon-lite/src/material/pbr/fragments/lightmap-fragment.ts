/**
 * PBR Lightmap Fragment
 *
 * Blends a baked lightmap into the shaded color, matching Babylon.js
 * `pbrBlockLightmapInit.fx` + `pbrBlockFinalColorComposition.fx`:
 *   - additive (default):            `finalColor.rgb += lightmapColor.rgb`
 *   - `useLightmapAsShadowmap`:      `finalColor.rgb *= lightmapColor.rgb`
 * where `lightmapColor.rgb = sample * lightmapLevel`, optionally sRGB→linear
 * decoded first (`GAMMALIGHTMAP`, i.e. BJS `Texture.gammaSpace`).
 *
 * BJS applies the lightmap before adding emissive. Lite normally folds emissive
 * into `color` earlier, so the multiplicative branch removes and re-adds it.
 * The unlit fragment does not include emissive, so that variant adds it here.
 *
 * Zero bytes in bundles for scenes that don't use a lightmap.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import { PBR2_HAS_REFRACTION, PBR2_HAS_UV2, PBR_HAS_SHEEN, PBR_HAS_SUBSURFACE } from "../pbr-flag-bits.js";
import { MSH_HAS_UV2 } from "../../mesh-features.js";

const STAGE_FRAGMENT = 0x2;

// Lightmap-local feature bits. Declared here (not in the shared pbr-flag-bits.ts)
// per GUIDANCE §4c′ so scenes without a lightmap retain zero bytes. Reserved in
// pbr-flag-bits.ts so no other feature claims them.
const PBR_HAS_LIGHTMAP = 1 << 13;
const PBR_LIGHTMAP_UV2 = 1 << 14;
const PBR_LIGHTMAP_SHADOWMAP = 1 << 16;
const PBR_LIGHTMAP_GAMMA = 1 << 18;
const PBR_LIGHTMAP_FLIP_V = 1 << 19;

// unlit-fragment.ts's own local bit, re-declared (not imported) so neither module
// pulls the other into a bundle that only uses one of them.
const PBR2_HAS_UNLIT = 1 << 8;

/**
 * Create the lightmap fragment.
 * @param usesUV2 - Sample the lightmap from TEXCOORD_1 instead of TEXCOORD_0.
 * @param shadowmap - Multiply instead of add (BJS `useLightmapAsShadowmap`).
 * @param gamma - Decode the sample from sRGB to linear (BJS `GAMMALIGHTMAP`).
 * @param flipV - Sample at `(u, 1 - v)` (BJS `Texture.uAng === π`).
 * @param afterUnlit - Order this fragment after the unlit fragment and add emissive
 * after the lightmap, matching Babylon.js final composition.
 * @param finalColorDependencies - Active fragments that reconstruct final color and
 * must complete before the lightmap is composed.
 */
export function createLightmapFragment(
    usesUV2: boolean,
    shadowmap: boolean,
    gamma: boolean,
    flipV: boolean,
    afterUnlit = false,
    finalColorDependencies: readonly string[] = []
): ShaderFragment {
    const baseUv = usesUV2 ? `input.uv2` : `input.uv`;
    const uv = flipV ? `vec2<f32>(${baseUv}.x,1.0-${baseUv}.y)` : baseUv;
    const raw = `textureSample(lmTexture,lmSampler,${uv}).rgb`;
    const lm = `${gamma ? `pow(${raw},vec3<f32>(2.2))` : raw}*material.lmLvl`;
    const blend = shadowmap ? (afterUnlit ? `color=color*(${lm})+emissive;` : `color=(color-emissive)*(${lm})+emissive;`) : afterUnlit ? `color+=${lm}+emissive;` : `color+=${lm};`;
    const dependencies = afterUnlit ? [...finalColorDependencies, "unlit"] : finalColorDependencies;
    return {
        _id: "lightmap",

        _dependencies: dependencies.length > 0 ? dependencies : undefined,

        _uboFields: [{ _name: "lmLvl", _type: "f32" }],

        _bindings: [
            { _name: "lmTexture", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "lmSampler", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT },
        ],

        _fragmentSlots: {
            NI: blend,
        },
    };
}

/** Write the lightmap material-UBO slice. */
export function writeLightmapUBO(data: Float32Array, material: PbrMaterialProps, offsets: ReadonlyMap<string, number>): void {
    const off = offsets.get("lmLvl");
    if (off === undefined) {
        return;
    }
    data[off / 4] = material.lightmapLevel ?? 1;
}

export const pbrExt: PbrExt = {
    id: "lightmap",
    phase: "fragment",
    detect(mat) {
        const m = mat as PbrMaterialProps;
        if (!m.lightmapTexture) {
            return { f: 0, f2: 0 };
        }
        let f = PBR_HAS_LIGHTMAP;
        let f2 = 0;
        if ((m.lightmapCoordIndex ?? 1) === 1) {
            // Reuse the shared UV2 plumbing (vertex attribute + varying + vertex-buffer slot).
            f |= PBR_LIGHTMAP_UV2;
            f2 |= PBR2_HAS_UV2;
        }
        if (m.useLightmapAsShadowmap) {
            f |= PBR_LIGHTMAP_SHADOWMAP;
        }
        if (m.gammaLightmap) {
            f |= PBR_LIGHTMAP_GAMMA;
        }
        if (!!m.lightmapTexture.invertY !== (m.lightmapTexture.uAng === Math.PI)) {
            f |= PBR_LIGHTMAP_FLIP_V;
        }
        return { f, f2 };
    },
    frag(ctx) {
        if (!(ctx._features & PBR_HAS_LIGHTMAP)) {
            return null;
        }
        return createLightmapFragment(
            (ctx._features & PBR_LIGHTMAP_UV2) !== 0 && (ctx._meshFeatures & MSH_HAS_UV2) !== 0,
            (ctx._features & PBR_LIGHTMAP_SHADOWMAP) !== 0,
            (ctx._features & PBR_LIGHTMAP_GAMMA) !== 0,
            (ctx._features & PBR_LIGHTMAP_FLIP_V) !== 0,
            (ctx._features2 & PBR2_HAS_UNLIT) !== 0,
            [
                ...((ctx._features & PBR_HAS_SHEEN) !== 0 ? ["sheen"] : []),
                ...((ctx._features2 & PBR2_HAS_REFRACTION) !== 0 ? ["refraction"] : []),
                ...((ctx._features & PBR_HAS_SUBSURFACE) !== 0 ? ["subsurface"] : []),
            ]
        );
    },
    writeUbo: writeLightmapUBO as PbrExt["writeUbo"],
    bind(ctx, entries, b) {
        const tex = (ctx._material as PbrMaterialProps).lightmapTexture;
        if (!tex) {
            return b;
        }
        entries.push({ binding: b++, resource: tex.view });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    textures(mat, out: Texture2D[]) {
        const tex = (mat as PbrMaterialProps).lightmapTexture;
        if (tex) {
            out.push(tex);
        }
    },
};
