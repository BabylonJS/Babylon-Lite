// Log (BJS FlowGraphLogBlock, glTF op `math/log`).
// Data block (PULL): emits `value` via fg-math's `fgLog`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgLog } from "../../fg-math.js";

export const logDef: FgBlockDef = {
    type: FgBlockType.Log,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgLog(a));
    },
};
