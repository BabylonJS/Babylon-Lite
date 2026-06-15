/**
 * Emissive Color Fragment
 *
 * Adds an emissiveColor vec3 uniform to MeshUniforms and uses it
 * in the fragment shader's emissive computation.
 *
 * Zero bytes in bundles for scenes that don't use emissive color.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_EMISSIVE_COLOR, PBR_HAS_EMISSIVE } from "../pbr-flag-bits.js";

/**
 * Create an emissive-color fragment.
 * @param hasEmissiveTexture - Whether the material also has an emissive texture.
 */
export function createEmissiveColorFragment(hasEmissiveTexture: boolean): ShaderFragment {
    return {
        _id: "emissive-color",

        _uboFields: [
            { _name: "emissiveColor", _type: "vec3<f32>" },
            { _name: "_emissiveColorPad", _type: "f32" },
        ],

        _fragmentSlots: {
            AT: hasEmissiveTexture ? `emissive=material.emissiveColor*textureSample(emissiveTexture,emissiveSampler,input.uv).rgb;` : `emissive=material.emissiveColor;`,
        },
    };
}

/** Write the emissive-color material-UBO slice. */
export function writeEmissiveUBO(data: Float32Array, material: PbrMaterialProps, offsets: ReadonlyMap<string, number>): void {
    if (!material.emissiveColor || !offsets.has("emissiveColor")) {
        return;
    }
    const off = offsets.get("emissiveColor")! / 4;
    data[off] = material.emissiveColor[0]!;
    data[off + 1] = material.emissiveColor[1]!;
    data[off + 2] = material.emissiveColor[2]!;
}

export const pbrExt: PbrExt = {
    id: "emissive-color",
    phase: "fragment",
    frag(ctx) {
        if (!(ctx._features & PBR_HAS_EMISSIVE_COLOR)) {
            return null;
        }
        return createEmissiveColorFragment((ctx._features & PBR_HAS_EMISSIVE) !== 0);
    },
    writeUbo: writeEmissiveUBO as PbrExt["writeUbo"],
};
