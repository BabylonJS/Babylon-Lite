// Saturate (BJS FlowGraphSaturateBlock, glTF op `math/saturate`).
// Data block (PULL): emits `value` via fg-math's `fgSaturate`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgSaturate } from "../../fg-math.js";

export const saturateDef: FgBlockDef = {
    type: FgBlockType.Saturate,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgSaturate(a));
    },
};
