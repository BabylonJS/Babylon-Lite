// Sign (BJS FlowGraphSignBlock, glTF op `math/sign`).
// Data block (PULL): emits `value` via fg-math's `fgSign`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgSign } from "../../fg-math.js";

export const signDef: FgBlockDef = {
    type: FgBlockType.Sign,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgSign(a));
    },
};
