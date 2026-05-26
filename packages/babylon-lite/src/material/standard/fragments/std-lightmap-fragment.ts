/** Standard Lightmap Fragment — additively blends lightmap into final color. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_LIGHTMAP_TEXTURE, LIGHTMAP_USES_UV2 } from "../standard-flags.js";

const STAGE_FRAGMENT = 0x2;

export function createStdLightmapFragment(usesUV2: boolean): ShaderFragment {
    const uv = usesUV2 ? "input.vv" : "input.vu";
    return {
        _id: "std-lightmap",
        _bindings: [
            { _name: "lT", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "lS", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT },
        ],
        _fragmentSlots: {
            BC: `color = vec4<f32>(color.rgb + textureSample(lT, lS, ${uv}).rgb * mat.lmLvl, color.a);`,
        },
    };
}

export const stdLightmapExt: StdExt = {
    _id: "std-lightmap",
    _phase: "mesh",
    _feature: HAS_LIGHTMAP_TEXTURE,
    _frag: (features) => createStdLightmapFragment((features & LIGHTMAP_USES_UV2) !== 0),
    _bind(mat, entries, b) {
        const tex = mat.lightmapTexture!;
        entries.push({ binding: b++, resource: tex.texture.createView() });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    _textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat.lightmapTexture) {
            out.push(mat.lightmapTexture);
        }
    },
};
