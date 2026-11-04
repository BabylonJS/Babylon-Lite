// BitwiseNot (BJS FlowGraphBitwiseNotBlock, glTF op `math/not`).
// Data block (PULL): emits `value` via fg-math's `fgNot`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgNot } from "../../fg-math.js";

export const bitwiseNotDef: FgBlockDef = {
    type: FgBlockType.BitwiseNot,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgNot(a));
    },
};
