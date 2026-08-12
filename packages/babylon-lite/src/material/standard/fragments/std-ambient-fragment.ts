/** Standard Ambient Texture Fragment — multiplies final diffuse by ambient occlusion texture. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_AMBIENT_TEXTURE, AMBIENT_USES_UV2 } from "../standard-flags.js";

const STAGE_FRAGMENT = 0x2;

export function createStdAmbientFragment(usesUV2: boolean): ShaderFragment {
    const uv = usesUV2 ? "input.vv" : "input.vu";
    return {
        _id: "std-ambient",
        _bindings: [
            { _name: "aT", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "aS", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT },
        ],
        _fragmentSlots: {
            AD: `baseAmbientColor = textureSample(aT, aS, ${uv}).rgb * mat.ambTexLvl;`,
        },
    };
}

export const stdAmbientExt: StdExt = {
    _id: "std-ambient",
    _phase: "mesh",
    _feature: HAS_AMBIENT_TEXTURE,
    _frag: (features) => createStdAmbientFragment((features & AMBIENT_USES_UV2) !== 0),
    _bind(mat, entries, b) {
        const tex = mat.ambientTexture!;
        entries.push({ binding: b++, resource: tex.texture.createView() });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    _textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat.ambientTexture) {
            out.push(mat.ambientTexture);
        }
    },
};
