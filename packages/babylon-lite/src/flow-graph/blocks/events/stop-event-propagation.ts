import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { allowFgEventPropagation, stopFgEventPropagation } from "../../event-bus.js";
import { activateSignal, getDataValue } from "../../runtime.js";
import { sigIn, sigOut, sockIn } from "../../sockets.js";
import { FgType } from "../../types.js";

export const stopEventPropagationDef: FgBlockDef = {
    type: FgBlockType.StopEventPropagation,
    build: () => ({
        dataIn: [sockIn("event", FgType.Reference), sockIn("stopImmediate", FgType.Boolean, false)],
        signalIn: [sigIn("in")],
        signalOut: [sigOut("out")],
    }),
    execute(block, ctx, env) {
        const event = getDataValue(ctx, env, block, "event");
        if (typeof event === "string") {
            stopFgEventPropagation(env.events, event, getDataValue(ctx, env, block, "stopImmediate") === true);
        }
        allowFgEventPropagation(env.events, () => activateSignal(ctx, env, block, "out"));
    },
};
