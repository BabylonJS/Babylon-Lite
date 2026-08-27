// Abs (BJS FlowGraphAbsBlock, glTF op `math/abs`).
// Data block (PULL): emits `value` = |a|, type-generic across number /
// FlowGraphInteger / Vector2-4 via fg-math's `fgAbs`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgAbs } from "../../fg-math.js";

export const absDef: FgBlockDef = {
    type: FgBlockType.Abs,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        setDataValue(ctx, block, "value", fgAbs(getDataValue(ctx, env, block, "a")));
    },
};
