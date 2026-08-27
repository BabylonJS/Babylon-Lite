// Divide (BJS FlowGraphDivideBlock, glTF op `math/div`).
// Data block (PULL): emits `value` = a ÷ b, type-generic across number /
// FlowGraphInteger / Vector2-4 via fg-math's `fgDiv`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgDiv } from "../../fg-math.js";

export const divideDef: FgBlockDef = {
    type: FgBlockType.Divide,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgDiv(a, b));
    },
};
