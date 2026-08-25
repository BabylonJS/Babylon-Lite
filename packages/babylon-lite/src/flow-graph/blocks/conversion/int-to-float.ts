// IntToFloat (BJS FlowGraphIntToFloat, glTF op `type/intToFloat`).
// Data block (PULL): FlowGraphInteger -> number (direct payload).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { isFgInt } from "../../custom-types/fg-integer.js";

export const intToFloatDef: FgBlockDef = {
    type: FgBlockType.IntToFloat,
    build: () => ({
        dataIn: [sockIn("a", FgType.Integer)],
        dataOut: [sockOut("value", FgType.Number)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", isFgInt(a) ? a.value : (a as number));
    },
};
