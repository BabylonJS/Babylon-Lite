// Atanh (BJS FlowGraphAtanhBlock, glTF op `math/atanh`).
// Data block (PULL): emits `value` via fg-math's `fgAtanh`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgAtanh } from "../../fg-math.js";

export const atanhDef: FgBlockDef = {
    type: FgBlockType.Atanh,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgAtanh(a));
    },
};
