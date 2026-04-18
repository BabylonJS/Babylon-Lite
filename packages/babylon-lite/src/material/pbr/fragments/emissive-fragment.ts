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
import { _registerPbrMaterialUboWriter } from "../pbr-flags.js";

/**
 * Create an emissive-color fragment.
 * @param hasEmissiveTexture Whether the material also has an emissive texture.
 */
export function createEmissiveColorFragment(hasEmissiveTexture: boolean): ShaderFragment {
    return {
        id: "emissive-color",

        // UBO fields are in the PBR template's baseMeshUboFields for byte-layout compat.

        fragmentSlots: {
            AT: hasEmissiveTexture
                ? `let emissive = material.emissiveColor * textureSample(emissiveTexture, emissiveSampler, input.uv).rgb;`
                : `let emissive = material.emissiveColor;`,
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

_registerPbrMaterialUboWriter("emissive-color", (d, m, o) => writeEmissiveUBO(d, m as PbrMaterialProps, o));
