// Cross (BJS FlowGraphCrossBlock, glTF op `math/cross`).
// Data block (PULL): emits `value` via fg-math's `fgCross`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgCross } from "../../fg-math.js";

export const crossDef: FgBlockDef = {
    type: FgBlockType.Cross,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Vector3)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgCross(a, b));
    },
};
