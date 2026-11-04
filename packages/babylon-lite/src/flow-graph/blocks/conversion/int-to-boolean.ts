// IntToBoolean (BJS FlowGraphIntToBoolean, glTF op `type/intToBool`).
// Data block (PULL): FlowGraphInteger -> boolean (0 -> false, else true).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { isFgInt } from "../../custom-types/fg-integer.js";

export const intToBooleanDef: FgBlockDef = {
    type: FgBlockType.IntToBoolean,
    build: () => ({
        dataIn: [sockIn("a", FgType.Integer)],
        dataOut: [sockOut("value", FgType.Boolean)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", isFgInt(a) ? a.value !== 0 : !!a);
    },
};
