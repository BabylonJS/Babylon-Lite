// SendCustomEvent (BJS FlowGraphSendCustomEventBlock, glTF op `event/send`).
// Execution block: gathers named data inputs and pumps a custom event on the
// shared bus so any ReceiveCustomEvent block in any graph can consume it.
//
// Config:
//   `eventId`    — string identifier for the event channel (required).
//   `valueNames` — optional string[] of data-input socket names whose values
//                  are bundled into `payload.values`. Derived from the glTF
//                  events table (deferred wiring — see report).
//
// glTF: `event/send`. The `configuration["event"]` integer index is mapped to
// `config.eventId` by declaration-mapper (configKeys). Full value-parameter
// sockets from the glTF events table are a deferred Phase 3i+ item.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgEventType } from "../../event-bus.js";
import { FgType } from "../../types.js";
import type { FgValue } from "../../types.js";
import { activateSignal, getDataValue } from "../../runtime.js";
import { pumpFgEvent } from "../../event-bus.js";
import { sigIn, sigOut, sockIn } from "../../sockets.js";

export const sendCustomEventDef: FgBlockDef = {
    type: FgBlockType.SendCustomEvent,
    build(config) {
        const valueNames = (config?.valueNames as string[] | undefined) ?? [];
        return {
            dataIn: valueNames.map((name) => sockIn(name, FgType.Any)),
            signalIn: [sigIn("in")],
            signalOut: [sigOut("out")],
        };
    },
    execute(block, ctx, env) {
        const eventId = (block.config?.eventId as string | undefined) ?? "";
        const valueNames = (block.config?.valueNames as string[] | undefined) ?? [];

        const values: Record<string, FgValue> = {};
        for (const name of valueNames) {
            values[name] = getDataValue(ctx, env, block, name);
        }

        pumpFgEvent(env.events, FgEventType.CustomEvent, { eventName: eventId, values });
        activateSignal(ctx, env, block, "out");
    },
};
