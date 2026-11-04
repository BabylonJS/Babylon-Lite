// Subtract (BJS FlowGraphSubtractBlock, glTF op `math/sub`).
// Data block (PULL): emits `value` = a − b, type-generic across number /
// FlowGraphInteger / Vector2-4 via fg-math's `fgSub`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgSub } from "../../fg-math.js";

export const subtractDef: FgBlockDef = {
    type: FgBlockType.Subtract,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgSub(a, b));
    },
};
