// Equality (BJS FlowGraphEqualityBlock, glTF op `math/eq`).
// Data block (PULL): emits `value` via fg-math's `fgEq`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgEq } from "../../fg-math.js";

export const equalityDef: FgBlockDef = {
    type: FgBlockType.Equality,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Boolean)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgEq(a, b));
    },
};
