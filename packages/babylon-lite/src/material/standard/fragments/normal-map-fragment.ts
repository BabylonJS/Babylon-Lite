/**
 * Normal Map Fragment (Cotangent Frame)
 *
 * Shared cotangent-frame bump mapping for Standard materials.
 * Uses screen-space derivatives to construct the TBN frame without
 * requiring explicit tangent vertex attributes.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StdExt } from "../standard-pipeline.js";
import { HAS_BUMP_TEXTURE } from "../standard-pipeline.js";
import { WGSL_PERTURB_NORMAL } from "../../../shader/wgsl-helpers.js";

const STAGE_FRAGMENT = 0x2;

/**
 * Create a bump/normal map fragment for Standard material.
 * @param bumpLevel The bump level (1.0 = default). bumpScale = 1/bumpLevel.
 */
export function createNormalMapFragment(): ShaderFragment {
    return {
        id: "normal-map",

        bindings: [
            { name: "bumpTex", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: STAGE_FRAGMENT },
            { name: "bumpSampler", type: { kind: "sampler", samplerType: "sampler" }, visibility: STAGE_FRAGMENT },
        ],

        helperFunctions: WGSL_PERTURB_NORMAL,

        fragmentSlots: {
            AC: `normalW = perturbNormal(input.vNormalW, input.vPositionW, input.vUV, mat.bs);`,
        },
    };
}

export const bumpStdExt: StdExt = {
    id: "normal-map",
    phase: "mesh",
    feature: HAS_BUMP_TEXTURE,
    frag: createNormalMapFragment,
    bind(mat: StandardMaterialProps, entries: GPUBindGroupEntry[], b: number): number {
        const tex = mat.bumpTexture!;
        entries.push({ binding: b++, resource: tex.texture.createView() });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat.bumpTexture) {
            out.push(mat.bumpTexture);
        }
    },
};
