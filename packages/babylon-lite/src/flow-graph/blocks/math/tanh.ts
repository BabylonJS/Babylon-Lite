// Tanh (BJS FlowGraphTanhBlock, glTF op `math/tanh`).
// Data block (PULL): emits `value` via fg-math's `fgTanh`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgTanh } from "../../fg-math.js";

export const tanhDef: FgBlockDef = {
    type: FgBlockType.Tanh,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgTanh(a));
    },
};
