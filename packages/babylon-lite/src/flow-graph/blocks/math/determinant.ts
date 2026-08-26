// Determinant (BJS FlowGraphDeterminantBlock, glTF op `math/determinant`).
// Data block (PULL): emits scalar `value` = det(a).
// Supports FgMatrix2D, FgMatrix3D, and Mat4.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgDeterminant } from "../../fg-math.js";

export const determinantDef: FgBlockDef = {
    type: FgBlockType.Determinant,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Number)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgDeterminant(a));
    },
};
