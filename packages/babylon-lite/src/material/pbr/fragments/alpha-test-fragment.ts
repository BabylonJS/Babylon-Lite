import type { PbrMaterialProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_ALPHA_TEST } from "../pbr-flag-bits.js";

export const alphaTestExt: PbrExt = {
    id: "alpha-test",
    phase: "fragment",
    frag(ctx) {
        return ctx._features & PBR_HAS_ALPHA_TEST
            ? {
                  _id: "alpha-test",
                  _uboFields: [{ _name: "alphaCutOff", _type: "f32" }],
                  _fragmentSlots: { AT: `if(alpha*material.materialAlpha<material.alphaCutOff){discard;}` },
              }
            : null;
    },
    writeUbo(data, mat, offsets) {
        const off = offsets.get("alphaCutOff");
        if (off !== undefined) {
            data[off / 4] = (mat as PbrMaterialProps).alphaCutOff ?? 0;
        }
    },
};
