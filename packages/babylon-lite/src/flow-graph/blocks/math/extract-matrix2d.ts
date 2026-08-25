// ExtractMatrix2D (BJS FlowGraphExtractMatrix2DBlock, glTF op `math/extract2x2`).
// Data block (PULL): FgMatrix2D input `input` → 4 scalar outputs `output_0..output_3`
// in column-major order (output_i = m.m[i]).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgExtractMatrix2D } from "../../fg-math.js";

export const extractMatrix2DDef: FgBlockDef = {
    type: FgBlockType.ExtractMatrix2D,
    build: () => ({
        dataIn: [sockIn("input", FgType.Matrix2D)],
        dataOut: Array.from({ length: 4 }, (_, i) => sockOut(`output_${i}`, FgType.Number)),
    }),
    updateOutputs(block, ctx, env) {
        const elems = fgExtractMatrix2D(getDataValue(ctx, env, block, "input"));
        for (let i = 0; i < 4; i++) {
            setDataValue(ctx, block, `output_${i}`, elems[i]!);
        }
    },
};
