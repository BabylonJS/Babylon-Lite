// Trunc (BJS FlowGraphTruncBlock, glTF op `math/trunc`).
// Data block (PULL): emits `value` via fg-math's `fgTrunc`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgTrunc } from "../../fg-math.js";

export const truncDef: FgBlockDef = {
    type: FgBlockType.Trunc,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgTrunc(a));
    },
};
