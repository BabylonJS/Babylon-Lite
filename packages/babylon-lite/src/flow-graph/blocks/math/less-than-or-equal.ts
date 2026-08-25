// LessThanOrEqual (BJS FlowGraphLessThanOrEqualBlock, glTF op `math/le`).
// Data block (PULL): emits `value` via fg-math's `fgLe`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgLe } from "../../fg-math.js";

export const lessThanOrEqualDef: FgBlockDef = {
    type: FgBlockType.LessThanOrEqual,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Boolean)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgLe(a, b));
    },
};
