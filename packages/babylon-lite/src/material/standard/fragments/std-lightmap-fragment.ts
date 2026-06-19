/** Standard Lightmap Fragment — blends a lightmap into the final color.
 *  Additive (default): `color += lightmap * level`.
 *  Shadowmap (`useLightmapAsShadowmap`): `color *= lightmap * level`.
 *  Matches BJS default.fragment.fx lightmap apply (raw sRGB sample, no gamma decode). */
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_LIGHTMAP_TEXTURE, LIGHTMAP_USES_UV2, LIGHTMAP_SHADOWMAP, LIGHTMAP_FLIP_V } from "../standard-flags.js";

const STAGE_FRAGMENT = 0x2;

export function createStdLightmapFragment(usesUV2: boolean, shadowmap: boolean, flipV: boolean): ShaderFragment {
    const baseUv = usesUV2 ? "input.vv" : "input.vu";
    const uv = flipV ? `vec2<f32>(${baseUv}.x, 1.0 - ${baseUv}.y)` : baseUv;
    const lm = `textureSample(lT, lS, ${uv}).rgb * mat.lmLvl`;
    const apply = shadowmap ? `color.rgb * (${lm})` : `color.rgb + ${lm}`;
    return {
        _id: "std-lightmap",
        _bindings: [
            { _name: "lT", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "lS", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT },
        ],
        _fragmentSlots: {
            BC: `color = vec4<f32>(${apply}, color.a);`,
        },
    };
}

export const stdLightmapExt: StdExt = {
    _id: "std-lightmap",
    _phase: "mesh",
    _feature: HAS_LIGHTMAP_TEXTURE,
    _frag: (features) => createStdLightmapFragment((features & LIGHTMAP_USES_UV2) !== 0, (features & LIGHTMAP_SHADOWMAP) !== 0, (features & LIGHTMAP_FLIP_V) !== 0),
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
