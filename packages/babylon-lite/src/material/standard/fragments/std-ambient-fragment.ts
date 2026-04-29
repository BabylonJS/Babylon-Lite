/** Standard Ambient Texture Fragment — multiplies final diffuse by ambient occlusion texture. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_AMBIENT_TEXTURE, AMBIENT_USES_UV2 } from "../standard-flags.js";

const STAGE_FRAGMENT = 0x2;

export function createStdAmbientFragment(usesUV2: boolean): ShaderFragment {
    const uv = usesUV2 ? "input.vUV2" : "input.vUV";
    return {
        id: "std-ambient",
        bindings: [
            { name: "ambientTex", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: STAGE_FRAGMENT },
            { name: "ambientSampler", type: { kind: "sampler", samplerType: "sampler" }, visibility: STAGE_FRAGMENT },
        ],
        fragmentSlots: {
            AD: `baseAmbientColor = textureSample(ambientTex, ambientSampler, ${uv}).rgb * mat.ambTexLvl;`,
        },
    };
}

export const stdAmbientExt: StdExt = {
    id: "std-ambient",
    phase: "mesh",
    feature: HAS_AMBIENT_TEXTURE,
    frag: (features) => createStdAmbientFragment((features & AMBIENT_USES_UV2) !== 0),
    bind(mat, entries, b) {
        const tex = mat.ambientTexture!;
        entries.push({ binding: b++, resource: tex.texture.createView() });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat.ambientTexture) {
            out.push(mat.ambientTexture);
        }
    },
};
