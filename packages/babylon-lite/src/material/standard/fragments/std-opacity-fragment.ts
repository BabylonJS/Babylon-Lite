/** Standard Opacity Texture Fragment — modulates alpha by opacity texture. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_OPACITY_TEXTURE, OPACITY_FROM_RGB } from "../standard-flags.js";

const STAGE_FRAGMENT = 0x2;

export function createStdOpacityFragment(fromRGB: boolean): ShaderFragment {
    const opacityCalc = fromRGB
        ? `{ let opSample = textureSample(oT, oS, input.vu); alpha *= dot(opSample.rgb, vec3<f32>(0.3, 0.59, 0.11)) * mat.opLvl; }`
        : `alpha *= textureSample(oT, oS, input.vu).a * mat.opLvl;`;
    return {
        _id: "std-opacity",
        _bindings: [
            { _name: "oT", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "oS", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT },
        ],
        _fragmentSlots: {
            AT: opacityCalc,
        },
    };
}

export const stdOpacityExt: StdExt = {
    _id: "std-opacity",
    _phase: "mesh",
    _feature: HAS_OPACITY_TEXTURE,
    _detect: (mat: StandardMaterialProps): number => (mat._opacityTexture ? HAS_OPACITY_TEXTURE | (mat.opacityFromRGB ? OPACITY_FROM_RGB : 0) : 0),
    _frag: (features) => createStdOpacityFragment((features & OPACITY_FROM_RGB) !== 0),
    _bind(mat, entries, b) {
        const tex = mat._opacityTexture!;
        entries.push({ binding: b++, resource: tex.texture.createView() });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    _textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat._opacityTexture) {
            out.push(mat._opacityTexture);
        }
    },
};
