// LessThan (BJS FlowGraphLessThanBlock, glTF op `math/lt`).
// Data block (PULL): emits boolean `value` = a < b (scalar comparison on the
// numeric payload of number / FlowGraphInteger) via fg-math's `fgLt`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgLt } from "../../fg-math.js";

export const lessThanDef: FgBlockDef = {
    type: FgBlockType.LessThan,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Boolean)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgLt(a, b));
    },
};
