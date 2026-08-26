// Asin (BJS FlowGraphAsinBlock, glTF op `math/asin`).
// Data block (PULL): emits `value` via fg-math's `fgAsin`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgAsin } from "../../fg-math.js";

export const asinDef: FgBlockDef = {
    type: FgBlockType.Asin,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgAsin(a));
    },
};
