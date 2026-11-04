// Throttle (BJS FlowGraphThrottleBlock, glTF op `flow/throttle`).
// Passes the first activation through and suppresses further activations until
// `duration` seconds have elapsed since the last pass-through. `reset` clears
// the cooldown immediately.
//
// LITE DIVERGENCE: BJS uses wall-clock (`Date.now()`) for timing. Lite uses a
// tick-driven countdown via `addPending`/`onTick` so tests can drive it with
// `tickFlowGraph` instead of real-time. Semantics are identical for properly
// ticked scenes.
//
// `lastRemainingTime` data output: 0 when passing, remaining seconds when blocked.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { activateSignal, addPending, cancelPendingForBlock, getDataValue, getExecVar, setDataValue, setExecVar } from "../../runtime.js";
import { sigIn, sigOut, sockIn, sockOut } from "../../sockets.js";

export const throttleDef: FgBlockDef = {
    type: FgBlockType.Throttle,
    build: () => ({
        dataIn: [sockIn("duration", FgType.Number, 0)],
        dataOut: [sockOut("lastRemainingTime", FgType.Number)],
        signalIn: [sigIn("in"), sigIn("reset")],
        signalOut: [sigOut("out"), sigOut("error")],
    }),
    updateOutputs(block, ctx) {
        setDataValue(ctx, block, "lastRemainingTime", getExecVar<number>(ctx, block, "lastRemainingTime", NaN));
    },
    execute(block, ctx, env, incomingSignal) {
        if (incomingSignal === "reset") {
            cancelPendingForBlock(ctx, block);
            setExecVar(ctx, block, "cooldownMs", 0);
            setExecVar(ctx, block, "lastRemainingTime", NaN);
            setDataValue(ctx, block, "lastRemainingTime", NaN);
            return;
        }

        const duration = getDataValue(ctx, env, block, "duration") as number;
        if (!isFinite(duration) || isNaN(duration) || duration <= 0) {
            activateSignal(ctx, env, block, "error");
            return;
        }

        const cooldown = getExecVar<number>(ctx, block, "cooldownMs", 0);
        if (cooldown <= 0) {
            // Ready to fire: reset cooldown and start countdown task.
            setExecVar(ctx, block, "cooldownMs", duration * 1000);
            setExecVar(ctx, block, "lastRemainingTime", 0);
            setDataValue(ctx, block, "lastRemainingTime", 0);
            addPending(ctx, block);
            activateSignal(ctx, env, block, "out");
        } else {
            // Still in cooldown: report remaining time but don't fire.
            setExecVar(ctx, block, "lastRemainingTime", cooldown / 1000);
            setDataValue(ctx, block, "lastRemainingTime", cooldown / 1000);
        }
    },
    onTick(block, ctx, _env, deltaMs, task) {
        const remaining = getExecVar<number>(ctx, block, "cooldownMs", 0) - deltaMs;
        if (remaining <= 0) {
            setExecVar(ctx, block, "cooldownMs", 0);
            task.done = true;
        } else {
            setExecVar(ctx, block, "cooldownMs", remaining);
        }
    },
    cancelPending(block, ctx) {
        setExecVar(ctx, block, "cooldownMs", 0);
    },
};
