// Atan2 (BJS FlowGraphATan2Block, glTF op `math/atan2`).
// Data block (PULL): emits `value` via fg-math's `fgAtan2`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgAtan2 } from "../../fg-math.js";

export const atan2Def: FgBlockDef = {
    type: FgBlockType.Atan2,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgAtan2(a, b));
    },
};
