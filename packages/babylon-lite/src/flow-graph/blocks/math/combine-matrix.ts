// CombineMatrix (BJS FlowGraphCombineMatrixBlock, glTF op `math/combine4x4`).
// Data block (PULL): 16 scalar inputs `input_0..input_15` (column-major order)
// → `value` (Mat4). Inputs map directly: input_i = m[i].

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgCombineMatrix } from "../../fg-math.js";

export const combineMatrixDef: FgBlockDef = {
    type: FgBlockType.CombineMatrix,
    build: () => ({
        dataIn: Array.from({ length: 16 }, (_, i) => sockIn(`input_${i}`, FgType.Number)),
        dataOut: [sockOut("value", FgType.Matrix)],
    }),
    updateOutputs(block, ctx, env) {
        const inputs = Array.from({ length: 16 }, (_, i) => {
            const v = getDataValue(ctx, env, block, `input_${i}`);
            return typeof v === "number" ? v : 0;
        });
        setDataValue(ctx, block, "value", fgCombineMatrix(inputs));
    },
};
