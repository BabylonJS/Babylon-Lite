// GreaterThan (BJS FlowGraphGreaterThanBlock, glTF op `math/gt`).
// Data block (PULL): emits `value` via fg-math's `fgGt`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgGt } from "../../fg-math.js";

export const greaterThanDef: FgBlockDef = {
    type: FgBlockType.GreaterThan,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Boolean)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgGt(a, b));
    },
};
