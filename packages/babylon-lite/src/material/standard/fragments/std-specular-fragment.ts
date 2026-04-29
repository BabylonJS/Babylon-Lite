/** Standard Specular Texture Fragment — replaces specular color with texture sample. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_SPECULAR_TEXTURE, SPECULAR_USES_UV2 } from "../standard-flags.js";

const STAGE_FRAGMENT = 0x2;

export function createStdSpecularFragment(usesUV2: boolean): ShaderFragment {
    const uv = usesUV2 ? "input.vUV2" : "input.vUV";
    return {
        id: "std-specular",
        bindings: [
            { name: "specularTex", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: STAGE_FRAGMENT },
            { name: "specularSampler", type: { kind: "sampler", samplerType: "sampler" }, visibility: STAGE_FRAGMENT },
        ],
        fragmentSlots: {
            AT: `specularColor = textureSample(specularTex, specularSampler, ${uv}).rgb;`,
        },
    };
}

export const stdSpecularExt: StdExt = {
    id: "std-specular",
    phase: "mesh",
    feature: HAS_SPECULAR_TEXTURE,
    frag: (features) => createStdSpecularFragment((features & SPECULAR_USES_UV2) !== 0),
    bind(mat, entries, b) {
        const tex = mat.specularTexture!;
        entries.push({ binding: b++, resource: tex.texture.createView() });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat.specularTexture) {
            out.push(mat.specularTexture);
        }
    },
};
