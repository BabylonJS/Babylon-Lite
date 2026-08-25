// RadToDeg (BJS FlowGraphRadToDegBlock, glTF op `math/deg`).
// Data block (PULL): emits `value` via fg-math's `fgRadToDeg`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgRadToDeg } from "../../fg-math.js";

export const radToDegDef: FgBlockDef = {
    type: FgBlockType.RadToDeg,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgRadToDeg(a));
    },
};
