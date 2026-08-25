// Atan (BJS FlowGraphAtanBlock, glTF op `math/atan`).
// Data block (PULL): emits `value` via fg-math's `fgAtan`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgAtan } from "../../fg-math.js";

export const atanDef: FgBlockDef = {
    type: FgBlockType.Atan,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgAtan(a));
    },
};
