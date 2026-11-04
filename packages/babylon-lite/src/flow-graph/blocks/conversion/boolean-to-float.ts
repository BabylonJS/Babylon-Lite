// BooleanToFloat (BJS FlowGraphBooleanToFloat, glTF op `type/boolToFloat`).
// Data block (PULL): boolean -> number (true->1, false->0).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";

export const booleanToFloatDef: FgBlockDef = {
    type: FgBlockType.BooleanToFloat,
    build: () => ({
        dataIn: [sockIn("a", FgType.Boolean, false)],
        dataOut: [sockOut("value", FgType.Number)],
    }),
    updateOutputs(block, ctx, env) {
        setDataValue(ctx, block, "value", getDataValue(ctx, env, block, "a") ? 1 : 0);
    },
};
