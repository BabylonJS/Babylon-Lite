/** Standard Specular Texture Fragment — replaces specular color with texture sample. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_SPECULAR_TEXTURE, SPECULAR_USES_UV2 } from "../standard-flags.js";
import { wgsl } from "../../../shader/wgsl.js";

const STAGE_FRAGMENT = 0x2;

export function createStdSpecularFragment(usesUV2: boolean): ShaderFragment {
    const uv = usesUV2 ? "input.vv" : "input.vu";
    return {
        _id: "std-specular",
        _bindings: [
            { _name: "sT", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "sS", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT },
        ],
        _fragmentSlots: {
            AT: wgsl`specularColor = textureSample(sT, sS, ${uv}).rgb;`,
        },
    };
}

export const stdSpecularExt: StdExt = {
    _id: "std-specular",
    _phase: "mesh",
    _feature: HAS_SPECULAR_TEXTURE,
    _detect: (mat: StandardMaterialProps): number => (mat._specularTexture ? HAS_SPECULAR_TEXTURE | (mat.specularCoordIndex === 1 ? SPECULAR_USES_UV2 : 0) : 0),
    _frag: (features) => createStdSpecularFragment((features & SPECULAR_USES_UV2) !== 0),
    _bind(mat, entries, b) {
        const tex = mat._specularTexture!;
        entries.push({ binding: b++, resource: tex.texture.createView() });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    _textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat._specularTexture) {
            out.push(mat._specularTexture);
        }
    },
};
