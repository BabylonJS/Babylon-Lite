// Cos (BJS FlowGraphCosBlock, glTF op `math/cos`).
// Data block (PULL): emits `value` via fg-math's `fgCos`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgCos } from "../../fg-math.js";

export const cosDef: FgBlockDef = {
    type: FgBlockType.Cos,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgCos(a));
    },
};
