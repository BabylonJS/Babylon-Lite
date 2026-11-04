// LeadingZeros (BJS FlowGraphLeadingZerosBlock, glTF op `math/clz`).
// Data block (PULL): emits `value` via fg-math's `fgClz`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgClz } from "../../fg-math.js";

export const leadingZerosDef: FgBlockDef = {
    type: FgBlockType.LeadingZeros,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgClz(a));
    },
};
