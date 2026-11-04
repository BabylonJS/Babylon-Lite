// SquareRoot (BJS FlowGraphSquareRootBlock, glTF op `math/sqrt`).
// Data block (PULL): emits `value` via fg-math's `fgSqrt`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgSqrt } from "../../fg-math.js";

export const squareRootDef: FgBlockDef = {
    type: FgBlockType.SquareRoot,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgSqrt(a));
    },
};
