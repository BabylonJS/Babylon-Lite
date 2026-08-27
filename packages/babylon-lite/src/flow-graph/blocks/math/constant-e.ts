// E constant (BJS FlowGraphEBlock, glTF op `math/E`).
// Data block (PULL): emits the constant `value`; no inputs.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { setDataValue } from "../../runtime.js";
import { sockOut } from "../../sockets.js";

export const eDef: FgBlockDef = {
    type: FgBlockType.E,
    build: () => ({
        dataOut: [sockOut("value", FgType.Number)],
    }),
    updateOutputs(block, ctx) {
        setDataValue(ctx, block, "value", Math.E);
    },
};
