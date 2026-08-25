// GetVariable (BJS FlowGraphGetVariableBlock, glTF op `variable/get`).
// Data block (PULL): emits `value` = the live graph variable named by
// `config.variable`, recomputed on every read.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { setDataValue } from "../../runtime.js";
import { sockOut } from "../../sockets.js";

export const getVariableDef: FgBlockDef = {
    type: FgBlockType.GetVariable,
    build: () => ({
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx) {
        const name = block.config?.variable as string;
        setDataValue(ctx, block, "value", ctx.userVariables[name]);
    },
};
