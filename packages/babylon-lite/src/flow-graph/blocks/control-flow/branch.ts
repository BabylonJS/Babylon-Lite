// Branch (BJS FlowGraphBranchBlock, glTF op `flow/branch`).
// Execution block: routes the incoming signal to `onTrue` or `onFalse` based on
// the boolean `condition` data input.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { activateSignal, getDataValue } from "../../runtime.js";
import { sigIn, sigOut, sockIn } from "../../sockets.js";

export const branchDef: FgBlockDef = {
    type: FgBlockType.Branch,
    build: () => ({
        dataIn: [sockIn("condition", FgType.Boolean, false)],
        signalIn: [sigIn("in")],
        signalOut: [sigOut("onTrue"), sigOut("onFalse")],
    }),
    execute(block, ctx, env) {
        if (getDataValue(ctx, env, block, "condition")) {
            activateSignal(ctx, env, block, "onTrue");
        } else {
            activateSignal(ctx, env, block, "onFalse");
        }
    },
};
