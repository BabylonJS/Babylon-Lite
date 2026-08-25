// Dot (BJS FlowGraphDotBlock, glTF op `math/dot`).
// Data block (PULL): emits `value` via fg-math's `fgDot`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgDot } from "../../fg-math.js";

export const dotDef: FgBlockDef = {
    type: FgBlockType.Dot,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Number)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgDot(a, b));
    },
};
