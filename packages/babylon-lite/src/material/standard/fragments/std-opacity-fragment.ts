/** Standard Opacity Texture Fragment — modulates alpha by opacity texture. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_OPACITY_TEXTURE, OPACITY_FROM_RGB } from "../standard-flags.js";

const STAGE_FRAGMENT = 0x2;

export function createStdOpacityFragment(fromRGB: boolean): ShaderFragment {
    const opacityCalc = fromRGB
        ? `{ let opSample = textureSample(opacityTex, opacitySampler, input.vUV); alpha *= dot(opSample.rgb, vec3<f32>(0.3, 0.59, 0.11)) * mat.opLvl; }`
        : `alpha *= textureSample(opacityTex, opacitySampler, input.vUV).a * mat.opLvl;`;
    return {
        id: "std-opacity",
        bindings: [
            { name: "opacityTex", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: STAGE_FRAGMENT },
            { name: "opacitySampler", type: { kind: "sampler", samplerType: "sampler" }, visibility: STAGE_FRAGMENT },
        ],
        fragmentSlots: {
            AT: opacityCalc,
        },
    };
}

export const stdOpacityExt: StdExt = {
    id: "std-opacity",
    phase: "mesh",
    feature: HAS_OPACITY_TEXTURE,
    frag: (features) => createStdOpacityFragment((features & OPACITY_FROM_RGB) !== 0),
    bind(mat, entries, b) {
        const tex = mat.opacityTexture!;
        entries.push({ binding: b++, resource: tex.texture.createView() });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat.opacityTexture) {
            out.push(mat.opacityTexture);
        }
    },
};
