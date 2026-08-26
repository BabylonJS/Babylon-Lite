// TrailingZeros (BJS FlowGraphTrailingZerosBlock, glTF op `math/ctz`).
// Data block (PULL): emits `value` via fg-math's `fgCtz`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgCtz } from "../../fg-math.js";

export const trailingZerosDef: FgBlockDef = {
    type: FgBlockType.TrailingZeros,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgCtz(a));
    },
};
