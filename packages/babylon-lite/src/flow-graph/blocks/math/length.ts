// Length (BJS FlowGraphLengthBlock, glTF op `math/length`).
// Data block (PULL): emits `value` via fg-math's `fgLength`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgLength } from "../../fg-math.js";

export const lengthDef: FgBlockDef = {
    type: FgBlockType.Length,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Number)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgLength(a));
    },
};
