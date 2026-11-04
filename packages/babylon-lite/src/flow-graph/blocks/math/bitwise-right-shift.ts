// BitwiseRightShift (BJS FlowGraphBitwiseRightShiftBlock, glTF op `math/asr`).
// Data block (PULL): emits `value` via fg-math's `fgAsr`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgAsr } from "../../fg-math.js";

export const bitwiseRightShiftDef: FgBlockDef = {
    type: FgBlockType.BitwiseRightShift,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgAsr(a, b));
    },
};
