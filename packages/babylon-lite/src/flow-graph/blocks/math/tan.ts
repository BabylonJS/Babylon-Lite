// Tan (BJS FlowGraphTanBlock, glTF op `math/tan`).
// Data block (PULL): emits `value` via fg-math's `fgTan`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgTan } from "../../fg-math.js";

export const tanDef: FgBlockDef = {
    type: FgBlockType.Tan,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgTan(a));
    },
};
