// Acosh (BJS FlowGraphAcoshBlock, glTF op `math/acosh`).
// Data block (PULL): emits `value` via fg-math's `fgAcosh`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgAcosh } from "../../fg-math.js";

export const acoshDef: FgBlockDef = {
    type: FgBlockType.Acosh,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgAcosh(a));
    },
};
