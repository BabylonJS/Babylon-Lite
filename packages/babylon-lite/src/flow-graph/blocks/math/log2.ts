// Log2 (BJS FlowGraphLog2Block, glTF op `math/log2`).
// Data block (PULL): emits `value` via fg-math's `fgLog2`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgLog2 } from "../../fg-math.js";

export const log2Def: FgBlockDef = {
    type: FgBlockType.Log2,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgLog2(a));
    },
};
