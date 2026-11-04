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
import { PBR_HAS_EMISSIVE_COLOR, PBR_HAS_EMISSIVE, PBR2_HAS_UV_TRANSFORM } from "../pbr-flag-bits.js";
import { wgsl } from "../../../shader/wgsl.js";

/**
 * Create an emissive-color fragment.
 * @param hasEmissiveTexture - Whether the material also has an emissive texture.
 * @param emissiveUV - UV expression for emissiveTexture. This slot replaces the
 * template's own emissive line, so it must sample where the template would have.
 */
export function createEmissiveColorFragment(hasEmissiveTexture: boolean, emissiveUV: string = "input.uv"): ShaderFragment {
    return {
        _id: "emissive-color",

        _uboFields: [
            { _name: "emissiveColor", _type: "vec3<f32>" },
            { _name: "_emissiveColorPad", _type: "f32" },
        ],

        _fragmentSlots: {
            AT: hasEmissiveTexture
                ? wgsl`emissive=material.emissiveColor*textureSample(emissiveTexture,emissiveSampler,${emissiveUV}).rgb;`
                : wgsl`emissive=material.emissiveColor;`,
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
        // Must match createPbrTemplateExt's `uvVarName("emissive", 8)`: the AT slot
        // replaces the template's own emissive line, so the two must sample the same
        // UV. Bit 1<<3 is emissive in the loader's per-channel UV1 mask (the private
        // contract documented in gltf-pbr-builder-ext.ts); ctx._uv2Mask is already
        // zeroed when uv2 isn't present. Derived here rather than threaded through
        // the shared composer so non-emissive scenes carry none of it.
        const emissiveUV = ctx._features2 & PBR2_HAS_UV_TRANSFORM ? "emissiveUV" : (ctx._uv2Mask ?? 0) & (1 << 3) ? "input.uv2" : "input.uv";
        return createEmissiveColorFragment((ctx._features & PBR_HAS_EMISSIVE) !== 0, emissiveUV);
    },
    writeUbo: writeEmissiveUBO as PbrExt["writeUbo"],
};
