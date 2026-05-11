/** Standard Emissive Texture Fragment — multiplies emissive contribution by texture sample. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_DEPTH_EMISSIVE_TEXTURE, HAS_EMISSIVE_TEXTURE } from "../standard-flags.js";

const STAGE_FRAGMENT = 0x2;

export function createStdEmissiveFragment(depthTexture: boolean): ShaderFragment {
    return {
        id: "std-emissive",
        bindings: [
            { name: "eT", type: { kind: "texture", textureType: "texture_2d<f32>", sampleType: depthTexture ? "unfilterable-float" : undefined }, visibility: STAGE_FRAGMENT },
            { name: "eS", type: { kind: "sampler", samplerType: depthTexture ? "sampler_non_filtering" : "sampler" }, visibility: STAGE_FRAGMENT },
        ],
        fragmentSlots: {
            AT: `emissiveContrib = mat.ec + textureSample(eT, eS, input.vu).rgb * mat.tl;`,
        },
    };
}

export const stdEmissiveExt: StdExt = {
    id: "std-emissive",
    phase: "mesh",
    feature: HAS_EMISSIVE_TEXTURE,
    frag: (features) => createStdEmissiveFragment((features & HAS_DEPTH_EMISSIVE_TEXTURE) !== 0),
    bind(mat: StandardMaterialProps, entries: GPUBindGroupEntry[], b: number): number {
        const tex = mat.emissiveTexture!;
        entries.push({ binding: b++, resource: tex.view });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat.emissiveTexture) {
            out.push(mat.emissiveTexture);
        }
    },
};
