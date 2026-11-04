// CombineMatrix3D (BJS FlowGraphCombineMatrix3DBlock, glTF op `math/combine3x3`).
// Data block (PULL): 9 scalar inputs `input_0..input_8` (column-major order)
// → `value` (FgMatrix3D). Inputs map directly: input_i = m[i].

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgCombineMatrix3D } from "../../fg-math.js";

export const combineMatrix3DDef: FgBlockDef = {
    type: FgBlockType.CombineMatrix3D,
    build: () => ({
        dataIn: Array.from({ length: 9 }, (_, i) => sockIn(`input_${i}`, FgType.Number)),
        dataOut: [sockOut("value", FgType.Matrix3D)],
    }),
    updateOutputs(block, ctx, env) {
        const inputs = Array.from({ length: 9 }, (_, i) => {
            const v = getDataValue(ctx, env, block, `input_${i}`);
            return typeof v === "number" ? v : 0;
        });
        setDataValue(ctx, block, "value", fgCombineMatrix3D(inputs));
    },
};
