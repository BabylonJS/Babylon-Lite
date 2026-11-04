// ForLoop (BJS FlowGraphForLoopBlock, glTF op `flow/for`).
// Synchronous loop: fires `executionFlow` for each integer from `startIndex` up
// to (but NOT including) `endIndex` with stride `step` (default 1). Fires
// `completed` when done. Caps at 1000 iterations to guard against infinite loops.
// BJS semantics: `for (i = startIndex; i < endIndex; i += step)`.
// `index` data output is updated each iteration (available to wired consumers).
// config.incrementIndexWhenLoopDone (default false): when true, `index` is
// advanced one extra step after the loop — this is always set by the glTF mapper.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { activateSignal, getDataValue, setDataValue, setExecVar } from "../../runtime.js";
import { sigIn, sigOut, sockIn, sockOut } from "../../sockets.js";
import { fgInt, isFgInt } from "../../custom-types/fg-integer.js";

const MAX_ITERATIONS = 1000;

function toNum(v: unknown): number {
    if (isFgInt(v)) {
        return v.value;
    }
    return (v as number) ?? 0;
}

export const forLoopDef: FgBlockDef = {
    type: FgBlockType.ForLoop,
    build: () => ({
        dataIn: [sockIn("startIndex", FgType.Any, 0), sockIn("endIndex", FgType.Any, 0), sockIn("step", FgType.Number, 1)],
        dataOut: [sockOut("index", FgType.Integer)],
        signalIn: [sigIn("in")],
        signalOut: [sigOut("executionFlow"), sigOut("completed")],
    }),
    updateOutputs(block, ctx) {
        // Expose the current index (kept in execVar between iterations).
        const i = (ctx.executionVariables[`${block.id}:index`] as number) ?? 0;
        setDataValue(ctx, block, "index", fgInt(i));
    },
    execute(block, ctx, env) {
        const start = toNum(getDataValue(ctx, env, block, "startIndex"));
        const step = toNum(getDataValue(ctx, env, block, "step")) || 1;
        let end = toNum(getDataValue(ctx, env, block, "endIndex"));
        let iterations = 0;

        for (let i = start; i < end; i += step) {
            setExecVar(ctx, block, "index", i);
            setDataValue(ctx, block, "index", fgInt(i));
            activateSignal(ctx, env, block, "executionFlow");
            // Re-read endIndex each iteration (body may modify it).
            end = toNum(getDataValue(ctx, env, block, "endIndex"));
            if (++iterations >= MAX_ITERATIONS) {
                break;
            }
        }

        if (block.config?.incrementIndexWhenLoopDone) {
            const cur = toNum(getDataValue(ctx, env, block, "endIndex"));
            setExecVar(ctx, block, "index", cur);
            setDataValue(ctx, block, "index", fgInt(cur));
        }

        activateSignal(ctx, env, block, "completed");
    },
};
