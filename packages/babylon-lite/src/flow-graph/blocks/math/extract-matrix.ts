// ExtractMatrix (BJS FlowGraphExtractMatrixBlock, glTF op `math/extract4x4`).
// Data block (PULL): Mat4 input `input` → 16 scalar outputs `output_0..output_15`
// in column-major order (output_i = m[i]).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgExtractMatrix } from "../../fg-math.js";

export const extractMatrixDef: FgBlockDef = {
    type: FgBlockType.ExtractMatrix,
    build: () => ({
        dataIn: [sockIn("input", FgType.Matrix)],
        dataOut: Array.from({ length: 16 }, (_, i) => sockOut(`output_${i}`, FgType.Number)),
    }),
    updateOutputs(block, ctx, env) {
        const elems = fgExtractMatrix(getDataValue(ctx, env, block, "input"));
        for (let i = 0; i < 16; i++) {
            setDataValue(ctx, block, `output_${i}`, elems[i]!);
        }
    },
};
