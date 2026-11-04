// Transpose (BJS FlowGraphTransposeBlock, glTF op `math/transpose`).
// Data block (PULL): emits `value` = transpose of input matrix `a`.
// Supports FgMatrix2D, FgMatrix3D, and Mat4 (all column-major).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgTranspose } from "../../fg-math.js";

export const transposeDef: FgBlockDef = {
    type: FgBlockType.Transpose,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgTranspose(a));
    },
};
