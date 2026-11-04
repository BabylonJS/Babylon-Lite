// Multiply (BJS FlowGraphMultiplyBlock, glTF op `math/mul`).
// Data block (PULL): emits `value` = a · b (per-component), type-generic across number /
// FlowGraphInteger / Vector2-4 via fg-math's `fgMul`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgMul } from "../../fg-math.js";

export const multiplyDef: FgBlockDef = {
    type: FgBlockType.Multiply,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgMul(a, b));
    },
};
