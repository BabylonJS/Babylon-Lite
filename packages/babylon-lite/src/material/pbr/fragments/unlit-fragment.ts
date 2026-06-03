/**
 * Unlit Fragment (KHR_materials_unlit).
 *
 * Replaces the lit-color computation with `baseColor * unlitColor` right
 * before the tonemap/gamma/contrast chain runs.  Depends on the IBL fragment
 * when present so our AI injection runs *after* IBL's, overwriting the IBL
 * color contribution.  The subsequent tonemap/gamma/contrast stages still
 * apply, matching BJS's unlit output under `createDefaultEnvironment`.
 *
 * Zero bytes in bundles for scenes that don't use unlit materials.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR2_HAS_UNLIT } from "../pbr-flag-bits.js";

export function createUnlitFragment(hasIbl: boolean): ShaderFragment {
    const assign = `color = baseColor * material.unlitColor;`;
    return {
        _id: "unlit",
        _dependencies: hasIbl ? ["ibl"] : undefined,
        _uboFields: [
            { _name: "unlitColor", _type: "vec3<f32>" },
            { _name: "_unlitColorPad", _type: "f32" },
        ],
        _fragmentSlots: hasIbl ? { AI: assign } : { NI: assign },
    };
}

/** Write the unlit material-UBO slice. */
export function writeUnlitUBO(data: Float32Array, material: PbrMaterialProps, offsets: ReadonlyMap<string, number>): void {
    if (!material.unlit || !offsets.has("unlitColor")) {
        return;
    }
    const off = offsets.get("unlitColor")! / 4;
    const tint = material.unlitColor ?? [1, 1, 1];
    data[off] = tint[0]!;
    data[off + 1] = tint[1]!;
    data[off + 2] = tint[2]!;
}

export const pbrExt: PbrExt = {
    id: "unlit",
    phase: "fragment",
    detect(mat) {
        return (mat as PbrMaterialProps).unlit ? { f: 0, f2: PBR2_HAS_UNLIT } : { f: 0, f2: 0 };
    },
    frag(ctx) {
        if (!(ctx._features2 & PBR2_HAS_UNLIT)) {
            return null;
        }
        return createUnlitFragment(ctx._hasIbl);
    },
    writeUbo: writeUnlitUBO as PbrExt["writeUbo"],
};
