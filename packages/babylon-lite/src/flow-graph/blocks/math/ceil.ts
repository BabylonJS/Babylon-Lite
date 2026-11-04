// Ceil (BJS FlowGraphCeilBlock, glTF op `math/ceil`).
// Data block (PULL): emits `value` via fg-math's `fgCeil`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgCeil } from "../../fg-math.js";

export const ceilDef: FgBlockDef = {
    type: FgBlockType.Ceil,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgCeil(a));
    },
};
