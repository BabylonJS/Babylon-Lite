// Constant (BJS FlowGraphConstantBlock, no dedicated glTF op — constant values
// are represented as inline literals in KHR_interactivity assets). Used for
// internal-only graphs and unit tests.
// config.value: the constant value to emit.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import type { FgValue } from "../../types.js";
import { setDataValue } from "../../runtime.js";
import { sockOut } from "../../sockets.js";

export const constantDef: FgBlockDef = {
    type: FgBlockType.Constant,
    build: () => ({
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx) {
        setDataValue(ctx, block, "value", (block.config?.value as FgValue) ?? undefined);
    },
};
