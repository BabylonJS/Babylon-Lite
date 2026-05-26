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
import type { StdExt } from "../standard-flags.js";
import { HAS_BUMP_TEXTURE } from "../standard-flags.js";
import { WGSL_PERTURB_NORMAL } from "../../../shader/wgsl-helpers.js";

const STAGE_FRAGMENT = 0x2;

/**
 * Create a bump/normal map fragment for Standard material.
 * @param bumpLevel The bump level (1.0 = default). bumpScale = 1/bumpLevel.
 */
export function createNormalMapFragment(): ShaderFragment {
    return {
        _id: "normal-map",

        _bindings: [
            { _name: "bT", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "bS", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT },
        ],

        _helperFunctions: WGSL_PERTURB_NORMAL,

        _fragmentSlots: {
            AC: `normalW = perturbNormal(input.vn, input.vp, input.vu, mat.bs);`,
        },
    };
}

export const bumpStdExt: StdExt = {
    _id: "normal-map",
    _phase: "mesh",
    _feature: HAS_BUMP_TEXTURE,
    _frag: createNormalMapFragment,
    _bind(mat: StandardMaterialProps, entries: GPUBindGroupEntry[], b: number): number {
        const tex = mat.bumpTexture!;
        entries.push({ binding: b++, resource: tex.texture.createView() });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    _textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat.bumpTexture) {
            out.push(mat.bumpTexture);
        }
    },
};
