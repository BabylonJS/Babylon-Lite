// SetDelay (BJS FlowGraphSetDelayBlock, glTF op `flow/setDelay`).
// Starts an async countdown of `duration` seconds, fires `out` immediately so
// sync flow continues, then fires `done` when the delay expires. Multiple
// concurrent delays are supported; each gets a unique index.
// `cancel` input cancels ALL pending delays on this block (matches BJS behaviour
// when called with its own `lastDelayIndex`).
// `lastDelayIndex` data output: the index of the most recently registered delay.
//
// CancelDelay coordination: each task's index is stored at
// `ctx.executionVariables["__delay_<index>"] = task` so CancelDelay can find
// and cancel it by index without a direct block reference.

import type { FgBlockDef } from "../../block-def.js";
import type { FgPendingTask } from "../../context.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { activateSignal, addPending, cancelPendingForBlock, getDataValue, getExecVar, setDataValue, setExecVar } from "../../runtime.js";
import { sigIn, sigOut, sockIn, sockOut } from "../../sockets.js";
import { fgInt } from "../../custom-types/fg-integer.js";

/** Global key for the monotonically-increasing delay sequence counter. */
const DELAY_SEQ_KEY = "__delaySeq";
/** Per-index key prefix where the live task object is stored. */
const DELAY_KEY = (idx: number) => `__delay_${idx}`;

export const setDelayDef: FgBlockDef = {
    type: FgBlockType.SetDelay,
    build: () => ({
        dataIn: [sockIn("duration", FgType.Number, 0)],
        dataOut: [sockOut("lastDelayIndex", FgType.Integer)],
        signalIn: [sigIn("in"), sigIn("cancel")],
        signalOut: [sigOut("out"), sigOut("done"), sigOut("error")],
    }),
    updateOutputs(block, ctx) {
        setDataValue(ctx, block, "lastDelayIndex", fgInt(getExecVar<number>(ctx, block, "lastDelayIndex", -1)));
    },
    execute(block, ctx, env, incomingSignal) {
        if (incomingSignal === "cancel") {
            // Cancel all pending delays for this block and clean up global registry.
            for (const task of ctx.pending) {
                if (task.blockId === block.id && !task.canceled && !task.done) {
                    const idx = task.state.delayIndex as number;
                    delete ctx.executionVariables[DELAY_KEY(idx)];
                }
            }
            cancelPendingForBlock(ctx, block);
            return;
        }

        const duration = getDataValue(ctx, env, block, "duration") as number;
        if (!isFinite(duration) || isNaN(duration) || duration < 0) {
            activateSignal(ctx, env, block, "error");
            return;
        }

        // Allocate the next global delay index.
        const seq = ((ctx.executionVariables[DELAY_SEQ_KEY] as number | undefined) ?? -1) + 1;
        ctx.executionVariables[DELAY_SEQ_KEY] = seq;

        setExecVar(ctx, block, "lastDelayIndex", seq);
        setDataValue(ctx, block, "lastDelayIndex", fgInt(seq));

        const task: FgPendingTask = addPending(ctx, block, { remainingMs: duration * 1000, delayIndex: seq });
        // Register in the global registry so CancelDelay can look it up.
        ctx.executionVariables[DELAY_KEY(seq)] = task;

        activateSignal(ctx, env, block, "out");
    },
    onTick(block, ctx, env, deltaMs, task) {
        const remaining = (task.state.remainingMs as number) - deltaMs;
        if (remaining <= 0) {
            task.done = true;
            const idx = task.state.delayIndex as number;
            delete ctx.executionVariables[DELAY_KEY(idx)];
            activateSignal(ctx, env, block, "done");
        } else {
            task.state.remainingMs = remaining;
        }
    },
    cancelPending(_block, ctx) {
        // Clean up any leftover global registry entries for canceled tasks.
        for (const key of Object.keys(ctx.executionVariables)) {
            if (key.startsWith("__delay_")) {
                const task = ctx.executionVariables[key] as FgPendingTask | undefined;
                if (task?.canceled) {
                    delete ctx.executionVariables[key];
                }
            }
        }
    },
};
