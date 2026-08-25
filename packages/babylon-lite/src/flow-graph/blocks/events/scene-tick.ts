// SceneTick (BJS FlowGraphSceneTickEventBlock, glTF op `event/onTick`).
// Event block fired every frame on the Tick channel. Outputs the elapsed time
// since start and the last frame delta (both in SECONDS, matching BJS), then
// fires `out`/`done`.
//
// The scene driver pumps the Tick event each frame with payload
// `{ deltaMs, deltaTime }`; the runtime stashes it at
// `executionVariables[`${id}:lastEvent`]` before calling `execute`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { FgEventType } from "../../event-bus.js";
import { activateSignal, getExecVar, setDataValue, setExecVar } from "../../runtime.js";
import { sigOut, sockOut } from "../../sockets.js";

interface TickPayload {
    deltaTime?: number;
    event?: string;
}

export const sceneTickDef: FgBlockDef = {
    type: FgBlockType.SceneTick,
    build: () => ({
        dataOut: [sockOut("timeSinceStart", FgType.Number), sockOut("deltaTime", FgType.Number), sockOut("event", FgType.Reference)],
        signalOut: [sigOut("out"), sigOut("done")],
        event: FgEventType.Tick,
    }),
    updateOutputs(block, ctx) {
        setDataValue(ctx, block, "timeSinceStart", getExecVar(ctx, block, "elapsed", 0));
        setDataValue(ctx, block, "deltaTime", getExecVar(ctx, block, "delta", 0));
        setDataValue(ctx, block, "event", getExecVar(ctx, block, "event", "/extensions/KHR_interactivity/events/sceneTick"));
    },
    execute(block, ctx, env) {
        const payload = getExecVar<TickPayload | undefined>(ctx, block, "lastEvent", undefined);
        const delta = payload?.deltaTime ?? 0;
        setExecVar(ctx, block, "elapsed", getExecVar(ctx, block, "elapsed", 0) + delta);
        setExecVar(ctx, block, "delta", delta);
        setExecVar(ctx, block, "event", "/extensions/KHR_interactivity/events/sceneTick");
        this.updateOutputs!(block, ctx, env);
        activateSignal(ctx, env, block, "done");
        activateSignal(ctx, env, block, "out");
    },
};
