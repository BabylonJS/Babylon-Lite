// WhileLoop (BJS FlowGraphWhileLoopBlock, glTF op `flow/while`).
// Fires `executionFlow` repeatedly while `condition` is truthy. Fires
// `completed` after the condition becomes false. Caps at 1000 iterations.
// BJS config `doWhile` (default false): when true, the body runs once before
// the first condition check (not exposed via glTF).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { activateSignal, getDataValue } from "../../runtime.js";
import { sigIn, sigOut, sockIn } from "../../sockets.js";

const MAX_ITERATIONS = 1000;

export const whileLoopDef: FgBlockDef = {
    type: FgBlockType.WhileLoop,
    build: () => ({
        dataIn: [sockIn("condition", FgType.Boolean, false)],
        signalIn: [sigIn("in")],
        signalOut: [sigOut("executionFlow"), sigOut("completed")],
    }),
    execute(block, ctx, env) {
        const doWhile = !!(block.config?.doWhile as boolean | undefined);
        let condition = doWhile || !!getDataValue(ctx, env, block, "condition");

        let i = 0;
        while (condition) {
            activateSignal(ctx, env, block, "executionFlow");
            if (++i >= MAX_ITERATIONS) {
                break;
            }
            condition = !!getDataValue(ctx, env, block, "condition");
        }

        activateSignal(ctx, env, block, "completed");
    },
};
