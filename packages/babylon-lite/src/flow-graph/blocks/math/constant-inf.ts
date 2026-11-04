// Inf constant (BJS FlowGraphInfBlock, glTF op `math/Inf`).
// Data block (PULL): emits the constant `value`; no inputs.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { setDataValue } from "../../runtime.js";
import { sockOut } from "../../sockets.js";

export const infDef: FgBlockDef = {
    type: FgBlockType.Inf,
    build: () => ({
        dataOut: [sockOut("value", FgType.Number)],
    }),
    updateOutputs(block, ctx) {
        setDataValue(ctx, block, "value", Number.POSITIVE_INFINITY);
    },
};
