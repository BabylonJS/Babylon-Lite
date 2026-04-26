/** Standard Emissive Texture Fragment — multiplies emissive contribution by texture sample. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StdExt } from "../standard-pipeline.js";
import { HAS_EMISSIVE_TEXTURE } from "../standard-pipeline.js";

const STAGE_FRAGMENT = 0x2;

export function createStdEmissiveFragment(): ShaderFragment {
    return {
        id: "std-emissive",
        bindings: [
            { name: "emissiveTex", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: STAGE_FRAGMENT },
            { name: "emissiveSampler", type: { kind: "sampler", samplerType: "sampler" }, visibility: STAGE_FRAGMENT },
        ],
        fragmentSlots: {
            AT: `emissiveContrib = mat.ec + textureSample(emissiveTex, emissiveSampler, input.vUV).rgb * mat.tl;`,
        },
    };
}

export const stdEmissiveExt: StdExt = {
    id: "std-emissive",
    phase: "mesh",
    feature: HAS_EMISSIVE_TEXTURE,
    frag: createStdEmissiveFragment,
    bind(mat: StandardMaterialProps, entries: GPUBindGroupEntry[], b: number): number {
        const tex = mat.emissiveTexture!;
        entries.push({ binding: b++, resource: tex.texture.createView() });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat.emissiveTexture) {
            out.push(mat.emissiveTexture);
        }
    },
};
