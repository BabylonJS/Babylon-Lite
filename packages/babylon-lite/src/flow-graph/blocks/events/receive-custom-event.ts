// ReceiveCustomEvent (BJS FlowGraphReceiveCustomEventBlock, glTF op `event/receive`).
// Event block: subscribes to `FgEventType.CustomEvent` on the shared bus.
// The runtime's `startFlowGraph` subscribes it BEFORE Start blocks fire, so a
// Send triggered by SceneStart is guaranteed to reach this receiver.
//
// When the bus fires, `execute` reads the stashed payload, checks that
// `payload.eventName` matches `config.eventId`, writes named data outputs from
// `payload.values`, then fires `out` (and the BJS-compatible `done`).
// Events whose name does not match are silently ignored.
//
// Config:
//   `eventId`    — string identifier that must match the sender's (required).
//   `valueNames` — optional string[] of data-output socket names populated from
//                  `payload.values`. Derived from the glTF events table (deferred
//                  wiring — see report).
//
// glTF: `event/receive`. `configuration["event"]` index → `config.eventId`
// (configKeys). Value outputs from the events table are a deferred Phase 3i+ item.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgEventType } from "../../event-bus.js";
import { FgType } from "../../types.js";
import type { FgValue } from "../../types.js";
import { activateSignal, getExecVar, setDataValue } from "../../runtime.js";
import { sigOut, sockOut } from "../../sockets.js";

export const receiveCustomEventDef: FgBlockDef = {
    type: FgBlockType.ReceiveCustomEvent,
    build(config) {
        const valueNames = (config?.valueNames as string[] | undefined) ?? [];
        return {
            dataOut: valueNames.map((name) => sockOut(name, FgType.Any)),
            signalOut: [sigOut("out"), sigOut("done")],
            event: FgEventType.CustomEvent,
        };
    },
    execute(block, ctx, env) {
        const eventId = (block.config?.eventId as string | undefined) ?? "";
        const valueNames = (block.config?.valueNames as string[] | undefined) ?? [];

        const payload = getExecVar<{ eventName?: string; values?: Record<string, FgValue> } | undefined>(ctx, block, "lastEvent", undefined);

        // Filter: only react to events that match this block's eventId.
        if (!payload || payload.eventName !== eventId) {
            return;
        }

        // Write named values from the payload into data outputs.
        for (const name of valueNames) {
            const v = payload.values?.[name];
            if (v !== undefined) {
                setDataValue(ctx, block, name, v);
            }
        }

        activateSignal(ctx, env, block, "done");
        activateSignal(ctx, env, block, "out");
    },
};
