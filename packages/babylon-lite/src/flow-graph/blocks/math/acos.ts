// Acos (BJS FlowGraphAcosBlock, glTF op `math/acos`).
// Data block (PULL): emits `value` via fg-math's `fgAcos`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgAcos } from "../../fg-math.js";

export const acosDef: FgBlockDef = {
    type: FgBlockType.Acos,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgAcos(a));
    },
};
