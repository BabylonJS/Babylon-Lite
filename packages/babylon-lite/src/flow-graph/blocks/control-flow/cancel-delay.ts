// CancelDelay (BJS FlowGraphCancelDelayBlock, glTF op `flow/cancelDelay`).
// Cancels a previously scheduled delay by its index (from SetDelay's
// `lastDelayIndex` output). Looks up the task via the global registry
// (`ctx.executionVariables["__delay_<index>"]`) populated by SetDelay.
// Fires `out` after cancellation (whether or not a matching delay was found).

import type { FgBlockDef } from "../../block-def.js";
import type { FgPendingTask } from "../../context.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { activateSignal, getDataValue } from "../../runtime.js";
import { sigIn, sigOut, sockIn } from "../../sockets.js";
import { isFgInt } from "../../custom-types/fg-integer.js";

export const cancelDelayDef: FgBlockDef = {
    type: FgBlockType.CancelDelay,
    build: () => ({
        dataIn: [sockIn("delayIndex", FgType.Integer)],
        signalIn: [sigIn("in")],
        signalOut: [sigOut("out")],
    }),
    execute(block, ctx, env) {
        const raw = getDataValue(ctx, env, block, "delayIndex");
        const idx = isFgInt(raw) ? raw.value : raw;
        if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
            activateSignal(ctx, env, block, "out");
            return;
        }
        const key = `__delay_${idx}`;
        const task = ctx.executionVariables[key] as FgPendingTask | undefined;
        if (task) {
            task.canceled = true;
            delete ctx.executionVariables[key];
        }
        activateSignal(ctx, env, block, "out");
    },
};
