// ExtractMatrix3D (BJS FlowGraphExtractMatrix3DBlock, glTF op `math/extract3x3`).
// Data block (PULL): FgMatrix3D input `input` → 9 scalar outputs `output_0..output_8`
// in column-major order (output_i = m.m[i]).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgExtractMatrix3D } from "../../fg-math.js";

export const extractMatrix3DDef: FgBlockDef = {
    type: FgBlockType.ExtractMatrix3D,
    build: () => ({
        dataIn: [sockIn("input", FgType.Matrix3D)],
        dataOut: Array.from({ length: 9 }, (_, i) => sockOut(`output_${i}`, FgType.Number)),
    }),
    updateOutputs(block, ctx, env) {
        const elems = fgExtractMatrix3D(getDataValue(ctx, env, block, "input"));
        for (let i = 0; i < 9; i++) {
            setDataValue(ctx, block, `output_${i}`, elems[i]!);
        }
    },
};
