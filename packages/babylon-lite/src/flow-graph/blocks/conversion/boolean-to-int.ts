// BooleanToInt (BJS FlowGraphBooleanToInt, glTF op `type/boolToInt`).
// Data block (PULL): boolean -> FlowGraphInteger (true->1, false->0).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgInt } from "../../custom-types/fg-integer.js";

export const booleanToIntDef: FgBlockDef = {
    type: FgBlockType.BooleanToInt,
    build: () => ({
        dataIn: [sockIn("a", FgType.Boolean, false)],
        dataOut: [sockOut("value", FgType.Integer)],
    }),
    updateOutputs(block, ctx, env) {
        setDataValue(ctx, block, "value", fgInt(getDataValue(ctx, env, block, "a") ? 1 : 0));
    },
};
