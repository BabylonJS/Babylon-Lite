// Exponential (BJS FlowGraphExpBlock, glTF op `math/exp`).
// Data block (PULL): emits `value` via fg-math's `fgExp`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgExp } from "../../fg-math.js";

export const exponentialDef: FgBlockDef = {
    type: FgBlockType.Exponential,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgExp(a));
    },
};
