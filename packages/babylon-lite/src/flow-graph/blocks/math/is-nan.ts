// IsNaN (BJS FlowGraphIsNaNBlock, glTF op `math/isNaN`).
// Data block (PULL): emits `value` via fg-math's `fgIsNaN`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgIsNaN } from "../../fg-math.js";

export const isNaNDef: FgBlockDef = {
    type: FgBlockType.IsNaN,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Boolean)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgIsNaN(a));
    },
};
