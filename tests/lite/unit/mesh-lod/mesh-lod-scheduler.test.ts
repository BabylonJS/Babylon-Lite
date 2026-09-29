/** MeshLoD fine-page scheduler unit tests.
 *
 *  Drives {@link createMeshLoDRequestScheduler} through injected deterministic timers
 *  and a controllable fetch harness (no network, no wall-clock sleeps) to prove every
 *  architecture §11.2 scheduler invariant: bounded concurrency, deduplication,
 *  priority/tie ordering, starvation prevention, two-frame obsolete removal/abort,
 *  stale-completion rejection, the exact retry count/delay/status matrix, and
 *  pause/resume suppression. */

import { describe, expect, it } from "vitest";
import {
    createMeshLoDRequestScheduler,
    disposeMeshLoDRequestScheduler,
    pumpMeshLoDScheduler,
    schedulerQueuedCount,
    setMeshLoDSchedulerConcurrency,
    submitMeshLoDDemand,
    type MeshLoDPageDemand,
    type MeshLoDRequestScheduler,
    type MeshLoDSchedulerCallbacks,
    type MeshLoDSchedulerConfig,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scheduler.js";
import { createMeshLoDError, type MeshLoDError, type MeshLoDErrorCode } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-errors.js";

/** Drain queued microtasks so the scheduler's `.then` completion handlers run. Uses a
 *  real macrotask (the scheduler's own retry timers are injected + faked separately). */
function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A deterministic, manually advanced timer source for retry delays. */
function createManualTimers(): {
    timers: { setTimer(delayMs: number, cb: () => void): unknown; clearTimer(handle: unknown): void };
    advance(ms: number): void;
    pending(): number;
} {
    let seq = 0;
    let now = 0;
    const scheduled = new Map<number, { at: number; cb: () => void }>();
    return {
        timers: {
            setTimer(delayMs, cb) {
                const id = ++seq;
                scheduled.set(id, { at: now + delayMs, cb });
                return id;
            },
            clearTimer(handle) {
                scheduled.delete(handle as number);
            },
        },
        advance(ms) {
            now += ms;
            const due = [...scheduled.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at);
            for (const [id, t] of due) {
                if (scheduled.delete(id)) {
                    t.cb();
                }
            }
        },
        pending: () => scheduled.size,
    };
}

/** A controllable fetch: records start order/counts and concurrency high-water mark;
 *  each page is resolved/rejected explicitly. Aborting the signal rejects with
 *  `MLOD_ABORTED`, mirroring the real range source. */
function createFetchHarness(): {
    fetchPage: MeshLoDSchedulerCallbacks["fetchPage"];
    resolve(pageId: number, bytes?: Uint8Array): void;
    reject(pageId: number, error: unknown): void;
    order: number[];
    starts(pageId: number): number;
    active(): number;
    maxActive(): number;
    isPending(pageId: number): boolean;
} {
    const deferreds = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: unknown) => void }>();
    const startCounts = new Map<number, number>();
    const order: number[] = [];
    let active = 0;
    let maxActive = 0;
    return {
        fetchPage(pageId, signal) {
            active++;
            maxActive = Math.max(maxActive, active);
            startCounts.set(pageId, (startCounts.get(pageId) ?? 0) + 1);
            order.push(pageId);
            return new Promise<Uint8Array>((resolve, reject) => {
                const settle = {
                    resolve: (b: Uint8Array) => {
                        if (deferreds.get(pageId) === settle) {
                            deferreds.delete(pageId);
                            active--;
                            resolve(b);
                        }
                    },
                    reject: (e: unknown) => {
                        if (deferreds.get(pageId) === settle) {
                            deferreds.delete(pageId);
                            active--;
                            reject(e);
                        }
                    },
                };
                deferreds.set(pageId, settle);
                if (signal.aborted) {
                    settle.reject(createMeshLoDError("MLOD_ABORTED", "aborted"));
                    return;
                }
                signal.addEventListener("abort", () => settle.reject(createMeshLoDError("MLOD_ABORTED", "aborted")), { once: true });
            });
        },
        resolve: (pageId, bytes = new Uint8Array(4)) => deferreds.get(pageId)?.resolve(bytes),
        reject: (pageId, error) => deferreds.get(pageId)?.reject(error),
        order,
        starts: (pageId) => startCounts.get(pageId) ?? 0,
        active: () => active,
        maxActive: () => maxActive,
        isPending: (pageId) => deferreds.has(pageId),
    };
}

interface Harness {
    scheduler: MeshLoDRequestScheduler;
    fetch: ReturnType<typeof createFetchHarness>;
    clock: ReturnType<typeof createManualTimers>;
    received: number[];
    failed: { pageId: number; error: MeshLoDError }[];
    setGeneration(g: number): void;
    setPaused(p: boolean): void;
}

function setup(config?: Partial<MeshLoDSchedulerConfig>): Harness {
    const fetch = createFetchHarness();
    const clock = createManualTimers();
    const received: number[] = [];
    const failed: { pageId: number; error: MeshLoDError }[] = [];
    let generation = 0;
    let paused = false;
    const callbacks: MeshLoDSchedulerCallbacks = {
        fetchPage: fetch.fetchPage,
        onPageReceived: (pageId) => received.push(pageId),
        onPageFailed: (pageId, error) => failed.push({ pageId, error }),
        currentGeneration: () => generation,
        isPaused: () => paused,
    };
    const scheduler = createMeshLoDRequestScheduler({
        maxConcurrentRequests: config?.maxConcurrentRequests ?? 2,
        retryCount: config?.retryCount ?? 0,
        retryDelaysMs: config?.retryDelaysMs ?? [250, 1000],
        obsoleteRequestGraceFrames: config?.obsoleteRequestGraceFrames ?? 2,
        callbacks,
        timers: clock.timers,
    });
    return {
        scheduler,
        fetch,
        clock,
        received,
        failed,
        setGeneration: (g) => (generation = g),
        setPaused: (p) => (paused = p),
    };
}

function demand(pairs: [pageId: number, priority: number][]): MeshLoDPageDemand[] {
    return pairs.map(([pageId, priority]) => ({ pageId, priority }));
}

function httpError(status: number): MeshLoDError {
    return createMeshLoDError("MLOD_HTTP_STATUS", "status", { actual: status });
}

describe("MeshLoD scheduler — concurrency, dedup, priority", () => {
    it("never exceeds the concurrency bound and starts highest priority first", async () => {
        const h = setup({ maxConcurrentRequests: 2 });
        submitMeshLoDDemand(
            h.scheduler,
            demand([
                [5, 0.1],
                [2, 0.9],
                [7, 0.5],
                [2, 0.9],
            ]),
            1
        );
        expect(h.scheduler.inFlightCount).toBe(2);
        expect(h.fetch.maxActive()).toBeLessThanOrEqual(2);
        // Highest priorities (2 @ 0.9, 7 @ 0.5) start; page 5 waits.
        expect(h.fetch.order).toEqual([2, 7]);
        expect(schedulerQueuedCount(h.scheduler)).toBe(1);

        h.fetch.resolve(2);
        await flush();
        expect(h.received).toContain(2);
        expect(h.fetch.order).toEqual([2, 7, 5]); // slot freed → next priority
        expect(h.fetch.maxActive()).toBeLessThanOrEqual(2);
    });

    it("deduplicates repeated demand for the same page into one transfer", async () => {
        const h = setup({ maxConcurrentRequests: 4 });
        submitMeshLoDDemand(h.scheduler, demand([[3, 0.5]]), 1);
        submitMeshLoDDemand(h.scheduler, demand([[3, 0.6]]), 2);
        submitMeshLoDDemand(h.scheduler, demand([[3, 0.7]]), 3);
        expect(h.fetch.starts(3)).toBe(1);
        expect(h.scheduler.inFlightCount).toBe(1);
        h.fetch.resolve(3);
        await flush();
        expect(h.received).toEqual([3]);
        expect(h.fetch.starts(3)).toBe(1);
    });

    it("breaks priority ties by ascending page id", async () => {
        const h = setup({ maxConcurrentRequests: 1 });
        submitMeshLoDDemand(
            h.scheduler,
            demand([
                [9, 0.5],
                [3, 0.5],
                [6, 0.5],
            ]),
            1
        );
        expect(h.fetch.order).toEqual([3]);
        h.fetch.resolve(3);
        await flush();
        h.fetch.resolve(6);
        await flush();
        expect(h.fetch.order).toEqual([3, 6, 9]);
    });

    it("prevents starvation: a later high-priority page starts before queued low-priority work", async () => {
        const h = setup({ maxConcurrentRequests: 1 });
        submitMeshLoDDemand(h.scheduler, demand([[8, 0.1]]), 1);
        expect(h.fetch.order).toEqual([8]);
        // A high-priority page arrives while page 8 is in flight (both still demanded).
        submitMeshLoDDemand(
            h.scheduler,
            demand([
                [8, 0.1],
                [1, 0.9],
            ]),
            2
        );
        expect(h.fetch.order).toEqual([8]); // bound is 1 — page 1 waits
        h.fetch.resolve(8);
        await flush();
        expect(h.fetch.order).toEqual([8, 1]); // visible page 1 starts next
    });

    it("keeps the in-flight bound across a resolve stream", async () => {
        const h = setup({ maxConcurrentRequests: 3 });
        submitMeshLoDDemand(
            h.scheduler,
            demand([
                [0, 0.1],
                [1, 0.2],
                [2, 0.3],
                [3, 0.4],
                [4, 0.5],
                [5, 0.6],
            ]),
            1
        );
        for (let i = 5; i >= 1; i--) {
            expect(h.scheduler.inFlightCount).toBeLessThanOrEqual(3);
            h.fetch.resolve(i);
            await flush();
            submitMeshLoDDemand(
                h.scheduler,
                demand(
                    [
                        [0, 0.1],
                        [1, 0.2],
                        [2, 0.3],
                        [3, 0.4],
                        [4, 0.5],
                        [5, 0.6],
                    ].filter(([p]) => p !== i) as [number, number][]
                ),
                1
            );
        }
        expect(h.fetch.maxActive()).toBeLessThanOrEqual(3);
        expect(h.scheduler.inFlightCount).toBeLessThanOrEqual(3);
    });
});

describe("MeshLoD scheduler — cancellation & staleness", () => {
    it("removes a queued page after two undemanded frames", async () => {
        const h = setup({ maxConcurrentRequests: 1, obsoleteRequestGraceFrames: 2 });
        submitMeshLoDDemand(
            h.scheduler,
            demand([
                [10, 0.9],
                [11, 0.1],
            ]),
            1
        ); // 10 in-flight, 11 queued
        expect(h.fetch.order).toEqual([10]);
        submitMeshLoDDemand(h.scheduler, demand([[10, 0.9]]), 2); // 11 undemanded (frame 2)
        expect(h.scheduler.requests.has(11)).toBe(true);
        submitMeshLoDDemand(h.scheduler, demand([[10, 0.9]]), 3); // 11 undemanded 2 frames → dropped
        expect(h.scheduler.requests.has(11)).toBe(false);
        expect(h.fetch.starts(11)).toBe(0);
    });

    it("aborts an in-flight page after two undemanded frames without a terminal failure", async () => {
        const h = setup({ maxConcurrentRequests: 2, obsoleteRequestGraceFrames: 2 });
        submitMeshLoDDemand(
            h.scheduler,
            demand([
                [20, 0.9],
                [21, 0.8],
            ]),
            1
        );
        expect(h.fetch.order).toEqual([20, 21]);
        submitMeshLoDDemand(h.scheduler, demand([[20, 0.9]]), 2);
        submitMeshLoDDemand(h.scheduler, demand([[20, 0.9]]), 3); // page 21 obsolete → aborted
        await flush();
        expect(h.scheduler.requests.has(21)).toBe(false);
        expect(h.failed.find((f) => f.pageId === 21)).toBeUndefined();
        expect(h.scheduler.inFlightCount).toBe(1); // only page 20 remains
        expect(h.received).not.toContain(21);
    });

    it("discards a completion from a superseded generation before residency mutation", async () => {
        const h = setup({ maxConcurrentRequests: 1 });
        submitMeshLoDDemand(h.scheduler, demand([[30, 0.9]]), 1);
        expect(h.fetch.order).toEqual([30]);
        h.setGeneration(1); // asset disposed / recovered mid-flight
        h.fetch.resolve(30);
        await flush();
        expect(h.received).not.toContain(30);
        expect(h.scheduler.requests.has(30)).toBe(false);
    });

    it("cancels everything on dispose and clears pending timers", async () => {
        const h = setup({ maxConcurrentRequests: 2, retryCount: 2 });
        submitMeshLoDDemand(
            h.scheduler,
            demand([
                [40, 0.9],
                [41, 0.8],
            ]),
            1
        );
        h.fetch.reject(41, httpError(503)); // schedule a retry
        await flush();
        expect(h.clock.pending()).toBe(1);
        disposeMeshLoDRequestScheduler(h.scheduler);
        expect(h.scheduler.requests.size).toBe(0);
        expect(h.scheduler.inFlightCount).toBe(0);
        expect(h.clock.pending()).toBe(0);
    });
});

describe("MeshLoD scheduler — retry policy", () => {
    it("retries a retryable failure after 250 ms then succeeds", async () => {
        const h = setup({ maxConcurrentRequests: 1, retryCount: 2, retryDelaysMs: [250, 1000] });
        submitMeshLoDDemand(h.scheduler, demand([[50, 0.9]]), 1);
        h.fetch.reject(50, httpError(503));
        await flush();
        expect(h.clock.pending()).toBe(1);
        expect(h.fetch.starts(50)).toBe(1);
        h.clock.advance(249);
        expect(h.fetch.starts(50)).toBe(1); // not yet
        h.clock.advance(1);
        expect(h.fetch.starts(50)).toBe(2); // retry started at 250 ms
        h.fetch.resolve(50);
        await flush();
        expect(h.received).toEqual([50]);
    });

    it("exhausts initial + two retries (250/1000 ms) then reports one terminal failure", async () => {
        const h = setup({ maxConcurrentRequests: 1, retryCount: 2, retryDelaysMs: [250, 1000] });
        submitMeshLoDDemand(h.scheduler, demand([[60, 0.9]]), 1);
        h.fetch.reject(60, httpError(500));
        await flush();
        h.clock.advance(250);
        expect(h.fetch.starts(60)).toBe(2);
        h.fetch.reject(60, httpError(500));
        await flush();
        h.clock.advance(1000);
        expect(h.fetch.starts(60)).toBe(3);
        h.fetch.reject(60, httpError(500));
        await flush();
        expect(h.fetch.starts(60)).toBe(3); // at most three transfers
        expect(h.failed.map((f) => f.pageId)).toEqual([60]);
        expect(h.scheduler.requests.has(60)).toBe(false);
    });

    it.each<[label: string, code: MeshLoDErrorCode, status: number | undefined, retryable: boolean]>([
        ["network failure", "MLOD_HTTP_STATUS", undefined, true],
        ["408 timeout", "MLOD_HTTP_STATUS", 408, true],
        ["429 throttle", "MLOD_HTTP_STATUS", 429, true],
        ["500 server", "MLOD_HTTP_STATUS", 500, true],
        ["503 unavailable", "MLOD_HTTP_STATUS", 503, true],
        ["400 bad request", "MLOD_HTTP_STATUS", 400, false],
        ["403 forbidden", "MLOD_HTTP_STATUS", 403, false],
        ["404 not found", "MLOD_HTTP_STATUS", 404, false],
        ["range protocol", "MLOD_HTTP_RANGE", undefined, false],
        ["integrity", "MLOD_PAGE_INTEGRITY", undefined, false],
        ["version", "MLOD_UNSUPPORTED_VERSION", undefined, false],
    ])("classifies %s as retryable=%s", async (_label, code, status, retryable) => {
        const h = setup({ maxConcurrentRequests: 1, retryCount: 1, retryDelaysMs: [250] });
        submitMeshLoDDemand(h.scheduler, demand([[70, 0.9]]), 1);
        const error = code === "MLOD_HTTP_STATUS" ? createMeshLoDError(code, "e", status === undefined ? {} : { actual: status }) : createMeshLoDError(code, "e");
        h.fetch.reject(70, error);
        await flush();
        if (retryable) {
            expect(h.clock.pending()).toBe(1);
            expect(h.failed).toHaveLength(0);
        } else {
            expect(h.clock.pending()).toBe(0);
            expect(h.failed.map((f) => f.pageId)).toEqual([70]);
        }
    });
});

describe("MeshLoD scheduler — pause/resume", () => {
    it("suppresses new requests while paused and starts them on resume", () => {
        const h = setup({ maxConcurrentRequests: 2 });
        h.setPaused(true);
        submitMeshLoDDemand(
            h.scheduler,
            demand([
                [80, 0.9],
                [81, 0.8],
            ]),
            1
        );
        expect(h.fetch.order).toEqual([]);
        expect(h.scheduler.inFlightCount).toBe(0);
        expect(h.scheduler.requests.size).toBe(2);
        h.setPaused(false);
        pumpMeshLoDScheduler(h.scheduler);
        expect(h.fetch.order).toEqual([80, 81]);
        expect(h.scheduler.inFlightCount).toBe(2);
    });

    it("does not start a retry that becomes eligible while paused until resume", async () => {
        const h = setup({ maxConcurrentRequests: 1, retryCount: 2, retryDelaysMs: [250, 1000] });
        submitMeshLoDDemand(h.scheduler, demand([[90, 0.9]]), 1);
        h.fetch.reject(90, httpError(503));
        await flush();
        h.setPaused(true);
        h.clock.advance(250); // retry timer fires → page re-queued but paused
        expect(h.fetch.starts(90)).toBe(1);
        h.setPaused(false);
        pumpMeshLoDScheduler(h.scheduler);
        expect(h.fetch.starts(90)).toBe(2);
    });

    it("raising the concurrency bound starts more queued transfers", () => {
        const h = setup({ maxConcurrentRequests: 1 });
        submitMeshLoDDemand(
            h.scheduler,
            demand([
                [100, 0.9],
                [101, 0.8],
                [102, 0.7],
            ]),
            1
        );
        expect(h.scheduler.inFlightCount).toBe(1);
        setMeshLoDSchedulerConcurrency(h.scheduler, 3);
        expect(h.scheduler.inFlightCount).toBe(3);
        expect(h.fetch.order).toEqual([100, 101, 102]);
    });
});
