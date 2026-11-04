// WaitAll (BJS FlowGraphWaitAllBlock, glTF op `flow/waitAll`).
// Waits for ALL N input signals (`in_0` … `in_{N-1}`) to fire before firing
// `completed`. Fires `out` for intermediate non-reset activations. `reset`
// clears all received flags. After `completed` fires the state resets so the
// block can be re-armed. `remainingInputs` data output counts unset slots.
// config.inputSignalCount: number of input flows (required, default 1).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { activateSignal, getExecVar, setDataValue, setExecVar } from "../../runtime.js";
import { sigIn, sigOut, sockOut } from "../../sockets.js";
import { fgInt } from "../../custom-types/fg-integer.js";

function inputSignalCount(config: Readonly<Record<string, unknown>> | undefined): number {
    const configured = config?.inputSignalCount;
    return typeof configured === "number" && Number.isFinite(configured) ? Math.max(1, Math.trunc(configured)) : 1;
}

export const waitAllDef: FgBlockDef = {
    type: FgBlockType.WaitAll,
    build: (config) => {
        const n = inputSignalCount(config);
        const signalIn = [sigIn("reset")];
        for (let i = 0; i < n; i++) {
            signalIn.push(sigIn(`in_${i}`));
        }
        return {
            dataOut: [sockOut("remainingInputs", FgType.Integer)],
            signalIn,
            signalOut: [sigOut("out"), sigOut("completed")],
        };
    },
    updateOutputs(block, ctx) {
        const n = inputSignalCount(block.config);
        const state = getExecVar<boolean[]>(ctx, block, "activationState", []);
        const remaining = state.length ? state.filter((v) => !v).length : n;
        setDataValue(ctx, block, "remainingInputs", fgInt(remaining));
    },
    execute(block, ctx, env, incomingSignal) {
        const n = inputSignalCount(block.config);
        let state = getExecVar<boolean[]>(ctx, block, "activationState", []);
        if (!state.length) {
            state = new Array(n).fill(false) as boolean[];
        }

        if (incomingSignal === "reset") {
            state.fill(false);
            setExecVar(ctx, block, "activationState", state.slice());
            setDataValue(ctx, block, "remainingInputs", fgInt(n));
            return;
        }

        // Mark the corresponding slot received (socket name is "in_<i>").
        const idxStr = incomingSignal.replace(/^in_/, "");
        const idx = parseInt(idxStr, 10);
        if (!isNaN(idx) && idx >= 0 && idx < n) {
            state[idx] = true;
        }

        const remaining = state.filter((v) => !v).length;
        setDataValue(ctx, block, "remainingInputs", fgInt(remaining));
        setExecVar(ctx, block, "activationState", state.slice());

        if (remaining === 0) {
            // All received — fire completed and reset for next round.
            state.fill(false);
            setExecVar(ctx, block, "activationState", state.slice());
            activateSignal(ctx, env, block, "completed");
        } else {
            activateSignal(ctx, env, block, "out");
        }
    },
};
