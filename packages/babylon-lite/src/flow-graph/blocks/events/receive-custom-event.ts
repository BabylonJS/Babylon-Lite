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
//                  `payload.values`. Derived from the glTF events table.
//
// glTF: `event/receive`. The parser resolves `configuration["event"]` through
// the event table and builds all typed value outputs.

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
        const valueTypes = (config?.valueTypes as FgType[] | undefined) ?? [];
        return {
            dataOut: [sockOut("event", FgType.Reference), ...valueNames.map((name, index) => sockOut(name, valueTypes[index] ?? FgType.Any))],
            signalOut: [sigOut("out"), sigOut("done")],
            event: FgEventType.CustomEvent,
        };
    },
    execute(block, ctx, env) {
        const eventId = (block.config?.eventId as string | undefined) ?? "";
        const valueNames = (block.config?.valueNames as string[] | undefined) ?? [];

        const payload = getExecVar<{ eventName?: string; event?: string; values?: Record<string, FgValue> } | undefined>(ctx, block, "lastEvent", undefined);

        // Filter: only react to events that match this block's eventId.
        if (!payload || payload.eventName !== eventId) {
            return;
        }

        setDataValue(ctx, block, "event", payload.event ?? "");

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
