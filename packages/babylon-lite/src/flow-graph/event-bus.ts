// Scene/coordinator-scoped event bus feeding flow-graph event blocks.
// Pure data (`FgEventBus`) + standalone subscribe/pump functions — NO methods
// on the interface (GUIDANCE §4b′). One bus is shared across all graphs in a
// scene so multiple `KHR_interactivity` graphs can exchange custom events.

import { FgEventType } from "./types.js";

export { FgEventType };

/** Payload carried by a pumped event. `tick` carries `{ deltaMs, deltaTime }`;
 *  `customEvent` carries `{ eventName, values }`. */
export interface FgEventPayload {
    [key: string]: unknown;
}

export type FgEventHandler = (payload: FgEventPayload) => void;

interface FgEventSubscription {
    readonly handler: FgEventHandler;
    readonly owner: object;
}

/** Pure-data event bus. Channel name → ordered list of handlers. */
export interface FgEventBus {
    /** @internal channel → handlers, in subscription order. */
    readonly _listeners: Map<string, FgEventSubscription[]>;
    /** @internal re-entrant event dispatch stack used by stopPropagation. */
    readonly _dispatchStack: { reference: string; stopImmediate: boolean; stopTransitive: boolean; allowTransitive: number }[];
    /** @internal Events awaiting the next runtime tick. */
    readonly _queue: { channel: string; payload: FgEventPayload }[];
}

/** Create an empty event bus. (Allocation is inside the factory, never at
 *  module scope, so the module stays tree-shakable.) */
export function createFgEventBus(): FgEventBus {
    return { _listeners: new Map(), _dispatchStack: [], _queue: [] };
}

/** Queue an event for delivery at the start of the next flow-graph tick. */
export function queueFgEvent(bus: FgEventBus, channel: string, payload: FgEventPayload): void {
    bus._queue.push({ channel, payload });
}

/** Deliver all events currently queued. Events queued by a handler are deferred
 * to the following flush so dispatch cannot recurse indefinitely. */
export function flushFgEvents(bus: FgEventBus): void {
    const queued = bus._queue.splice(0, bus._queue.length);
    for (const event of queued) {
        pumpFgEvent(bus, event.channel, event.payload);
    }
}

/** Subscribe `handler` to a channel. Returns an unsubscribe function.
 *  Handlers fire in subscription order — callers control ordering by the order
 *  in which they subscribe (see runtime init-priority). */
export function subscribeFgEvent(bus: FgEventBus, channel: string, handler: FgEventHandler, owner: object = bus): () => void {
    let subscriptions = bus._listeners.get(channel);
    if (!subscriptions) {
        subscriptions = [];
        bus._listeners.set(channel, subscriptions);
    }
    const subscription = { handler, owner };
    subscriptions.push(subscription);
    return () => {
        const list = bus._listeners.get(channel);
        if (!list) {
            return;
        }
        const i = list.indexOf(subscription);
        if (i >= 0) {
            list.splice(i, 1);
        }
    };
}

/** Dispatch `payload` to every handler subscribed to `channel`. Iterates a
 *  snapshot so a handler may safely (un)subscribe during dispatch. */
export function pumpFgEvent(bus: FgEventBus, channel: string, payload: FgEventPayload): void {
    const subscriptions = bus._listeners.get(channel);
    if (!subscriptions || subscriptions.length === 0) {
        return;
    }
    const reference = typeof payload.event === "string" ? payload.event : `/extensions/KHR_interactivity/events/${String(payload.eventName ?? channel)}`;
    const handlersByOwner = new Map<object, FgEventHandler[]>();
    for (const { handler, owner } of subscriptions.slice()) {
        const handlers = handlersByOwner.get(owner);
        if (handlers) {
            handlers.push(handler);
        } else {
            handlersByOwner.set(owner, [handler]);
        }
    }
    for (const handlers of handlersByOwner.values()) {
        pumpFgEventHandlers(bus, handlers, { ...payload, event: reference });
    }
}

/** Dispatch to an explicit handler set. Lifecycle events use this to keep
 * stopImmediate scoped to one behavior graph even when graphs share a bus. */
export function pumpFgEventHandlers(bus: FgEventBus, handlers: readonly FgEventHandler[], payload: FgEventPayload): void {
    const reference = typeof payload.event === "string" ? payload.event : `/extensions/KHR_interactivity/events/${String(payload.eventName ?? "")}`;
    const dispatch = { reference, stopImmediate: false, stopTransitive: false, allowTransitive: 0 };
    bus._dispatchStack.push(dispatch);
    try {
        const eventPayload = { ...payload, event: reference };
        for (const handler of handlers) {
            handler(eventPayload);
            if (dispatch.stopImmediate) {
                break;
            }
            dispatch.stopTransitive = false;
        }
    } finally {
        bus._dispatchStack.pop();
    }
}

/** Stop transitive signal propagation for the most recent matching in-flight
 * event. `stopImmediate` additionally stops sibling event handlers. */
export function stopFgEventPropagation(bus: FgEventBus, reference: string, stopImmediate: boolean): void {
    for (let i = bus._dispatchStack.length - 1; i >= 0; i--) {
        const dispatch = bus._dispatchStack[i]!;
        if (dispatch.reference === reference) {
            dispatch.stopTransitive = true;
            dispatch.stopImmediate ||= stopImmediate;
            return;
        }
    }
}

/** Whether the active event dispatch has requested that its signal cascade stop. */
export function isFgEventTransitivePropagationStopped(bus: FgEventBus): boolean {
    const dispatch = bus._dispatchStack[bus._dispatchStack.length - 1];
    return dispatch ? dispatch.stopTransitive && dispatch.allowTransitive === 0 : false;
}

/** Run the stopPropagation block's own output cascade after propagation stops. */
export function allowFgEventPropagation(bus: FgEventBus, callback: () => void): void {
    const dispatch = bus._dispatchStack[bus._dispatchStack.length - 1];
    if (!dispatch) {
        callback();
        return;
    }
    dispatch.allowTransitive++;
    try {
        callback();
    } finally {
        dispatch.allowTransitive--;
    }
}

/** Remove every listener from the bus. */
export function clearFgEventBus(bus: FgEventBus): void {
    bus._listeners.clear();
    bus._queue.length = 0;
    bus._dispatchStack.length = 0;
}
