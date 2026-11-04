// DoN (BJS FlowGraphDoNBlock, glTF op `flow/doN`).
// Fires `out` for the first N activations (where N = `maxExecutions` data input).
// Tracks count in `executionCount` data output. The `reset` signal resets the
// counter to 0 (or config.startIndex, default 0). After N executions the block
// is silent until reset.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { activateSignal, getDataValue, getExecVar, setDataValue, setExecVar } from "../../runtime.js";
import { sigIn, sigOut, sockIn, sockOut } from "../../sockets.js";
import { fgInt, isFgInt } from "../../custom-types/fg-integer.js";

function toInt(v: unknown): number {
    if (isFgInt(v)) {
        return v.value;
    }
    return (v as number) | 0;
}

export const doNDef: FgBlockDef = {
    type: FgBlockType.DoN,
    build: () => ({
        dataIn: [sockIn("maxExecutions", FgType.Integer, fgInt(0))],
        dataOut: [sockOut("executionCount", FgType.Integer)],
        signalIn: [sigIn("in"), sigIn("reset")],
        signalOut: [sigOut("out")],
    }),
    updateOutputs(block, ctx) {
        setDataValue(ctx, block, "executionCount", fgInt(getExecVar<number>(ctx, block, "count", 0)));
    },
    execute(block, ctx, env, incomingSignal) {
        if (incomingSignal === "reset") {
            const startIdx = toInt(block.config?.startIndex ?? 0);
            setExecVar(ctx, block, "count", startIdx);
            setDataValue(ctx, block, "executionCount", fgInt(startIdx));
            return;
        }
        const max = toInt(getDataValue(ctx, env, block, "maxExecutions"));
        const count = getExecVar<number>(ctx, block, "count", 0);
        if (count < max) {
            const next = count + 1;
            setExecVar(ctx, block, "count", next);
            setDataValue(ctx, block, "executionCount", fgInt(next));
            activateSignal(ctx, env, block, "out");
        }
    },
};
