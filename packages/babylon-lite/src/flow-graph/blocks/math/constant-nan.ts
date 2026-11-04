// NaN constant (BJS FlowGraphNaNBlock, glTF op `math/NaN`).
// Data block (PULL): emits the constant `value`; no inputs.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { setDataValue } from "../../runtime.js";
import { sockOut } from "../../sockets.js";

export const nanDef: FgBlockDef = {
    type: FgBlockType.NaN,
    build: () => ({
        dataOut: [sockOut("value", FgType.Number)],
    }),
    updateOutputs(block, ctx) {
        setDataValue(ctx, block, "value", Number.NaN);
    },
};
