// GreaterThanOrEqual (BJS FlowGraphGreaterThanOrEqualBlock, glTF op `math/ge`).
// Data block (PULL): emits `value` via fg-math's `fgGe`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgGe } from "../../fg-math.js";

export const greaterThanOrEqualDef: FgBlockDef = {
    type: FgBlockType.GreaterThanOrEqual,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Boolean)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgGe(a, b));
    },
};
