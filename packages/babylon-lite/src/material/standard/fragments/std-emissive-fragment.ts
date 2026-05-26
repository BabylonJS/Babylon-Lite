/** Standard Emissive Texture Fragment — multiplies emissive contribution by texture sample. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_DEPTH_EMISSIVE_TEXTURE, HAS_EMISSIVE_TEXTURE } from "../standard-flags.js";

const STAGE_FRAGMENT = 0x2;

export function createStdEmissiveFragment(depthTexture: boolean): ShaderFragment {
    return {
        _id: "std-emissive",
        _bindings: [
            {
                _name: "eT",
                _type: { _kind: "texture", _textureType: "texture_2d<f32>", _sampleType: depthTexture ? "unfilterable-float" : undefined },
                _visibility: STAGE_FRAGMENT,
            },
            { _name: "eS", _type: { _kind: "sampler", _samplerType: depthTexture ? "sampler_non_filtering" : "sampler" }, _visibility: STAGE_FRAGMENT },
        ],
        _fragmentSlots: {
            AT: `emissiveContrib = mat.ec + textureSample(eT, eS, input.vu).rgb * mat.tl;`,
        },
    };
}

export const stdEmissiveExt: StdExt = {
    _id: "std-emissive",
    _phase: "mesh",
    _feature: HAS_EMISSIVE_TEXTURE,
    _frag: (features) => createStdEmissiveFragment((features & HAS_DEPTH_EMISSIVE_TEXTURE) !== 0),
    _bind(mat: StandardMaterialProps, entries: GPUBindGroupEntry[], b: number): number {
        const tex = mat.emissiveTexture!;
        entries.push({ binding: b++, resource: tex.view });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    _textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat.emissiveTexture) {
            out.push(mat.emissiveTexture);
        }
    },
};
