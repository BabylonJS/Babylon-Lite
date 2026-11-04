// IsInfinity (BJS FlowGraphIsInfBlock, glTF op `math/isInf`).
// Data block (PULL): emits `value` via fg-math's `fgIsInf`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgIsInf } from "../../fg-math.js";

export const isInfinityDef: FgBlockDef = {
    type: FgBlockType.IsInfinity,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Boolean)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgIsInf(a));
    },
};
