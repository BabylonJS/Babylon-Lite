/**
 * Emissive Color Fragment
 *
 * Adds an emissiveColor vec3 uniform to MeshUniforms and uses it
 * in the fragment shader's emissive computation.
 *
 * Pulled in only by `setPbrEmissive`, so scenes without emissive pay zero bytes.
 * Contributes the `PBR_HAS_EMISSIVE_COLOR` feature bit from its own `detect()`,
 * keeping that check out of the always-loaded `_computePbrMaterialFeatures`.
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
    if (!material._emissiveColor || !offsets.has("emissiveColor")) {
        return;
    }
    const off = offsets.get("emissiveColor")! / 4;
    data[off] = material._emissiveColor[0]!;
    data[off + 1] = material._emissiveColor[1]!;
    data[off + 2] = material._emissiveColor[2]!;
}

export const pbrExt: PbrExt = {
    id: "emissive-color",
    phase: "fragment",
    detect(mat: unknown): { f: number; f2: number } {
        // Contributed here rather than by the always-loaded `_computePbrMaterialFeatures`,
        // so the base feature computation carries no emissive check. The companion
        // PBR_HAS_EMISSIVE (emissiveTexture) bit stays there — it drives the bind-group
        // layout, which must be known without this ext loaded.
        return { f: (mat as PbrMaterialProps)._emissiveColor ? PBR_HAS_EMISSIVE_COLOR : 0, f2: 0 };
    },
    frag(ctx) {
        if (!(ctx._features & PBR_HAS_EMISSIVE_COLOR)) {
            return null;
        }
        return createEmissiveColorFragment((ctx._features & PBR_HAS_EMISSIVE) !== 0);
    },
    writeUbo: writeEmissiveUBO as PbrExt["writeUbo"],
};
