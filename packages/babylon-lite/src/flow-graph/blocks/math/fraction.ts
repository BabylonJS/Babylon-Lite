// Fraction (BJS FlowGraphFractionBlock, glTF op `math/fract`).
// Data block (PULL): emits `value` via fg-math's `fgFract`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgFract } from "../../fg-math.js";

export const fractionDef: FgBlockDef = {
    type: FgBlockType.Fraction,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgFract(a));
    },
};
