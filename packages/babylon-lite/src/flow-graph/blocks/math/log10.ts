// Log10 (BJS FlowGraphLog10Block, glTF op `math/log10`).
// Data block (PULL): emits `value` via fg-math's `fgLog10`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgLog10 } from "../../fg-math.js";

export const log10Def: FgBlockDef = {
    type: FgBlockType.Log10,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgLog10(a));
    },
};
