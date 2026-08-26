// BitwiseXor (BJS FlowGraphBitwiseXorBlock, glTF op `math/xor`).
// Data block (PULL): emits `value` via fg-math's `fgXor`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgXor } from "../../fg-math.js";

export const bitwiseXorDef: FgBlockDef = {
    type: FgBlockType.BitwiseXor,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgXor(a, b));
    },
};
