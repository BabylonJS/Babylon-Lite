// FloatToBoolean (BJS FlowGraphFloatToBoolean, glTF op `type/floatToBool`).
// Data block (PULL): number -> boolean (0 and NaN -> false, else true).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";

export const floatToBooleanDef: FgBlockDef = {
    type: FgBlockType.FloatToBoolean,
    build: () => ({
        dataIn: [sockIn("a", FgType.Number, 0)],
        dataOut: [sockOut("value", FgType.Boolean)],
    }),
    updateOutputs(block, ctx, env) {
        setDataValue(ctx, block, "value", !!(getDataValue(ctx, env, block, "a") as number));
    },
};
