// Sin (BJS FlowGraphSinBlock, glTF op `math/sin`).
// Data block (PULL): emits `value` via fg-math's `fgSin`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgSin } from "../../fg-math.js";

export const sinDef: FgBlockDef = {
    type: FgBlockType.Sin,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgSin(a));
    },
};
