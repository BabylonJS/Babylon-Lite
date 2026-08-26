// Add (BJS FlowGraphAddBlock, glTF op `math/add`).
// Data block (PULL): emits `value` = a + b, type-generic across number /
// FlowGraphInteger / Vector2-4 via fg-math's `fgAdd`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgAdd } from "../../fg-math.js";

export const addDef: FgBlockDef = {
    type: FgBlockType.Add,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgAdd(a, b));
    },
};
