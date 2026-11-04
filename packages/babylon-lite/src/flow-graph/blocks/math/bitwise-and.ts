// BitwiseAnd (BJS FlowGraphBitwiseAndBlock, glTF op `math/and`).
// Data block (PULL): emits `value` via fg-math's `fgAnd`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgAnd } from "../../fg-math.js";

export const bitwiseAndDef: FgBlockDef = {
    type: FgBlockType.BitwiseAnd,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgAnd(a, b));
    },
};
