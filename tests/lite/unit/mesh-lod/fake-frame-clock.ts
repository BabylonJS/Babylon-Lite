/** Deterministic manual clock for MeshLoD streaming fixtures (Task 6.4).
 *
 *  Implements the injectable {@link MeshLoDSchedulerTimers} seam so retry delays
 *  (250 ms / 1000 ms) advance under explicit test control instead of wall-clock
 *  `setTimeout`. Timers fire in `(fireAt, insertion)` order when the test advances the
 *  clock, so bounded-retry and obsolete-grace lifecycles are fully deterministic. */

import type { MeshLoDSchedulerTimers } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scheduler.js";

interface Scheduled {
    readonly id: number;
    readonly fireAt: number;
    readonly seq: number;
    readonly callback: () => void;
}

export interface FakeFrameClock extends MeshLoDSchedulerTimers {
    /** Current virtual time in milliseconds. */
    readonly now: number;
    /** Advance virtual time by `ms`, firing every timer whose deadline is reached in
     *  deadline-then-insertion order (timers scheduled while firing are honoured). */
    advanceMs(ms: number): void;
    /** Number of timers still pending. */
    pendingCount(): number;
}

/** Create a deterministic manual clock. */
export function createFakeFrameClock(): FakeFrameClock {
    let now = 0;
    let nextId = 1;
    let nextSeq = 1;
    const scheduled: Scheduled[] = [];

    return {
        get now(): number {
            return now;
        },
        setTimer(delayMs: number, callback: () => void): unknown {
            const item: Scheduled = { id: nextId++, fireAt: now + delayMs, seq: nextSeq++, callback };
            scheduled.push(item);
            return item.id;
        },
        clearTimer(handle: unknown): void {
            const index = scheduled.findIndex((s) => s.id === handle);
            if (index !== -1) {
                scheduled.splice(index, 1);
            }
        },
        advanceMs(ms: number): void {
            now += ms;
            for (;;) {
                let next: Scheduled | undefined;
                for (const s of scheduled) {
                    if (s.fireAt <= now && (!next || s.fireAt < next.fireAt || (s.fireAt === next.fireAt && s.seq < next.seq))) {
                        next = s;
                    }
                }
                if (!next) {
                    return;
                }
                scheduled.splice(scheduled.indexOf(next), 1);
                next.callback();
            }
        },
        pendingCount(): number {
            return scheduled.length;
        },
    };
}
