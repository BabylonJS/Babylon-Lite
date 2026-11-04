// FloatToInt (BJS FlowGraphFloatToInt, glTF op `type/floatToInt`).
// Data block (PULL): number -> FlowGraphInteger. `config.roundingMode` selects
// floor/ceil/round; default truncates toward zero (BJS `value | 0`).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgInt } from "../../custom-types/fg-integer.js";

export const floatToIntDef: FgBlockDef = {
    type: FgBlockType.FloatToInt,
    build: () => ({
        dataIn: [sockIn("a", FgType.Number, 0)],
        dataOut: [sockOut("value", FgType.Integer)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a") as number;
        const mode = block.config?.roundingMode as string | undefined;
        const r = mode === "floor" ? Math.floor(a) : mode === "ceil" ? Math.ceil(a) : mode === "round" ? Math.round(a) : Math.trunc(a);
        setDataValue(ctx, block, "value", fgInt(r));
    },
};
