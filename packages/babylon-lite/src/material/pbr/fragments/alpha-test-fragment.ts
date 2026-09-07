import type { PbrMaterialProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_ALPHA_TEST } from "../pbr-flag-bits.js";
import { wgsl } from "../../../shader/wgsl.js";

export const pbrExt: PbrExt = {
    id: "alpha-test",
    phase: "fragment",
    detect(mat) {
        return ((mat as PbrMaterialProps)._alphaCutOff ?? 0) > 0 ? { f: PBR_HAS_ALPHA_TEST, f2: 0 } : { f: 0, f2: 0 };
    },
    frag(ctx) {
        return ctx._features & PBR_HAS_ALPHA_TEST
            ? {
                  _id: "alpha-test",
                  _uboFields: [{ _name: "alphaCutOff", _type: "f32" }],
                  _fragmentSlots: { AT: wgsl`if(alpha*material.materialAlpha<material.alphaCutOff){discard;}` },
              }
            : null;
    },
    writeUbo(data, mat, offsets) {
        const off = offsets.get("alphaCutOff");
        if (off !== undefined) {
            data[off / 4] = (mat as PbrMaterialProps)._alphaCutOff ?? 0;
        }
    },
};
