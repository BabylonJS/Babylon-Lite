// InvertMatrix (BJS FlowGraphInvertMatrixBlock, glTF op `math/inverse`).
// Data block (PULL): emits `value` = inverse of input matrix `a`.
// Returns identity when singular. Supports FgMatrix2D, FgMatrix3D, and Mat4.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgInvertMatrix } from "../../fg-math.js";

export const invertMatrixDef: FgBlockDef = {
    type: FgBlockType.InvertMatrix,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgInvertMatrix(a));
    },
};
