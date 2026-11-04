// CombineMatrix2D (BJS FlowGraphCombineMatrix2DBlock, glTF op `math/combine2x2`).
// Data block (PULL): 4 scalar inputs `input_0..input_3` (column-major order)
// → `value` (FgMatrix2D). Inputs map directly: input_i = m[i].

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgCombineMatrix2D } from "../../fg-math.js";

export const combineMatrix2DDef: FgBlockDef = {
    type: FgBlockType.CombineMatrix2D,
    build: () => ({
        dataIn: Array.from({ length: 4 }, (_, i) => sockIn(`input_${i}`, FgType.Number)),
        dataOut: [sockOut("value", FgType.Matrix2D)],
    }),
    updateOutputs(block, ctx, env) {
        const inputs = Array.from({ length: 4 }, (_, i) => {
            const v = getDataValue(ctx, env, block, `input_${i}`);
            return typeof v === "number" ? v : 0;
        });
        setDataValue(ctx, block, "value", fgCombineMatrix2D(inputs));
    },
};
