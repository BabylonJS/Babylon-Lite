/** MeshLoD fine-page request scheduler — bounded, deduplicated, cancellable,
 *  priority-ordered, retry-bounded streaming of fine `.mlod` pages.
 *
 *  Phase 5 selection emits per-page demand priorities (visible screen-space benefit
 *  relative to transfer cost). This scheduler turns a per-frame demand snapshot into
 *  at most one queued/in-flight request per page (architecture §11.2): it sorts
 *  descending priority then ascending page id, enforces a mutable concurrency bound,
 *  removes queued demand and aborts in-flight work after two obsolete frames, rejects
 *  stale generation/token completions before any residency mutation, and retries
 *  network/408/429/5xx failures on a bounded 250 ms / 1000 ms schedule while treating
 *  aborts, other 4xx, protocol, integrity, and version errors as permanent. Streaming
 *  pause suppresses only new fine requests and retries — never bootstrap, resident
 *  geometry, or the coarse fallback.
 *
 *  Decode, cache allocation, upload, and residency commit are owned by the runtime;
 *  the scheduler only fetches raw stored bytes and hands a fresh, non-stale terminal
 *  result to its callbacks. Timers and fetch are injected so unit fixtures drive the
 *  full lifecycle deterministically without a network or wall-clock sleeps. */

import { isMeshLoDError } from "./mesh-lod-errors.js";
import type { MeshLoDError } from "./mesh-lod-errors.js";

/** One demanded page: its id and this frame's benefit/cost priority. */
export interface MeshLoDPageDemand {
    readonly pageId: number;
    readonly priority: number;
}

/** Request lifecycle state tracked by the scheduler (distinct from the page's
 *  residency state on {@link MeshLoDPageRuntime}). */
export type MeshLoDPageRequestState = "queued" | "fetching" | "retry-wait";

/** Per-page in-flight/queued request record. Reused across retries for one page id;
 *  a fresh demand after cancellation creates a new record. */
export interface MeshLoDPageRequest {
    readonly pageId: number;
    /** Latest benefit/cost priority (updated every frame the page is demanded). */
    priority: number;
    /** Frame index of the most recent demand — drives the two-frame obsolete grace. */
    lastDemandFrame: number;
    /** Asset generation stamped when the active transfer started; a completion whose
     *  generation no longer matches is discarded before residency mutation. */
    generation: number;
    /** Unique token stamped at each transfer start; a completion carrying a stale
     *  token (superseded record) is discarded. */
    token: number;
    state: MeshLoDPageRequestState;
    /** 0 = initial attempt; 1..retryCount = retry number. */
    attempt: number;
    /** Abort controller for the active transfer (`fetching` only). */
    controller: AbortController | null;
    /** Pending retry timer handle (`retry-wait` only). */
    retryTimer: unknown;
    /** True once cancelled/aborted; guards every async completion path. */
    cancelled: boolean;
}

/** Injectable timer seam. Defaults to wall-clock `setTimeout`; fixtures substitute a
 *  manual clock so retry delays advance deterministically. */
export interface MeshLoDSchedulerTimers {
    setTimer(delayMs: number, callback: () => void): unknown;
    clearTimer(handle: unknown): void;
}

/** Runtime-owned collaborators. The scheduler never decodes or mutates residency
 *  itself — it only fetches bytes and reports fresh terminal results. */
export interface MeshLoDSchedulerCallbacks {
    /** Fetch one page's raw stored bytes; rejects with a {@link MeshLoDError} on
     *  failure. `signal` aborts the transfer when the request is cancelled. */
    fetchPage(pageId: number, signal: AbortSignal): Promise<Uint8Array>;
    /** Commit a fresh, non-stale successfully fetched page (decode/upload/residency). */
    onPageReceived(pageId: number, bytes: Uint8Array, request: MeshLoDPageRequest): void;
    /** Report a terminal failure (permanent error or retries exhausted). Fine failures
     *  are page-local and never fail the coarse asset. */
    onPageFailed(pageId: number, error: MeshLoDError, request: MeshLoDPageRequest): void;
    /** Current asset generation, for stale-completion rejection. */
    currentGeneration(): number;
    /** Whether fine streaming is paused (suppresses new requests and retries only). */
    isPaused(): boolean;
}

export interface MeshLoDSchedulerConfig {
    maxConcurrentRequests: number;
    retryCount: number;
    retryDelaysMs: readonly number[];
    /** Frames a page may go undemanded before its queued/in-flight work is dropped. */
    obsoleteRequestGraceFrames: number;
    callbacks: MeshLoDSchedulerCallbacks;
    timers?: MeshLoDSchedulerTimers;
}

/** Mutable scheduler state. One instance per asset; stored on the asset runtime. */
export interface MeshLoDRequestScheduler {
    /** Mutable upper bound on simultaneous transfers (REQ-STREAM-2). */
    maxConcurrentRequests: number;
    readonly retryCount: number;
    readonly retryDelaysMs: readonly number[];
    readonly obsoleteRequestGraceFrames: number;
    /** Active requests keyed by page id — guarantees one request per page. */
    readonly requests: Map<number, MeshLoDPageRequest>;
    /** Most recent demand frame index. */
    frame: number;
    /** Requests currently in the `fetching` state (excludes aborted-pending). */
    inFlightCount: number;
    /** Monotonic token source. */
    nextToken: number;
    readonly callbacks: MeshLoDSchedulerCallbacks;
    readonly timers: MeshLoDSchedulerTimers;
}

const DEFAULT_TIMERS: MeshLoDSchedulerTimers = {
    setTimer(delayMs, callback) {
        return setTimeout(callback, delayMs);
    },
    clearTimer(handle) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
};

/** Create a scheduler from resolved settings and runtime callbacks. */
export function createMeshLoDRequestScheduler(config: MeshLoDSchedulerConfig): MeshLoDRequestScheduler {
    return {
        maxConcurrentRequests: config.maxConcurrentRequests,
        retryCount: config.retryCount,
        retryDelaysMs: config.retryDelaysMs.slice(),
        obsoleteRequestGraceFrames: config.obsoleteRequestGraceFrames,
        requests: new Map(),
        frame: 0,
        inFlightCount: 0,
        nextToken: 0,
        callbacks: config.callbacks,
        timers: config.timers ?? DEFAULT_TIMERS,
    };
}

/** Number of queued + retry-waiting (not yet in-flight) requests. */
export function schedulerQueuedCount(scheduler: MeshLoDRequestScheduler): number {
    let count = 0;
    for (const request of scheduler.requests.values()) {
        if (request.state !== "fetching") {
            count++;
        }
    }
    return count;
}

/** Merge a per-frame demand snapshot, drop obsolete work, then start eligible
 *  transfers. Call once per frame (an empty snapshot still advances the frame so the
 *  two-frame obsolete grace and pause/resume behave correctly). */
export function submitMeshLoDDemand(scheduler: MeshLoDRequestScheduler, demand: readonly MeshLoDPageDemand[], frame: number): void {
    scheduler.frame = frame;
    for (const item of demand) {
        const existing = scheduler.requests.get(item.pageId);
        if (existing) {
            existing.priority = item.priority;
            existing.lastDemandFrame = frame;
            existing.cancelled = false;
        } else {
            scheduler.requests.set(item.pageId, {
                pageId: item.pageId,
                priority: item.priority,
                lastDemandFrame: frame,
                generation: scheduler.callbacks.currentGeneration(),
                token: 0,
                state: "queued",
                attempt: 0,
                controller: null,
                retryTimer: null,
                cancelled: false,
            });
        }
    }
    pruneObsolete(scheduler);
    pumpMeshLoDScheduler(scheduler);
}

/** Start as many queued transfers as the concurrency bound and pause state allow,
 *  highest priority first (ties broken by ascending page id). */
export function pumpMeshLoDScheduler(scheduler: MeshLoDRequestScheduler): void {
    if (scheduler.callbacks.isPaused()) {
        return;
    }
    while (scheduler.inFlightCount < scheduler.maxConcurrentRequests) {
        const next = pickQueued(scheduler);
        if (!next) {
            return;
        }
        startRequest(scheduler, next);
    }
}

/** Apply a new concurrency bound; a raised bound starts more queued transfers. A
 *  lowered bound never aborts running transfers (coarse rendering is unaffected). */
export function setMeshLoDSchedulerConcurrency(scheduler: MeshLoDRequestScheduler, maxConcurrentRequests: number): void {
    scheduler.maxConcurrentRequests = maxConcurrentRequests;
    pumpMeshLoDScheduler(scheduler);
}

/** Cancel every request and clear pending timers (disposal / device recovery). */
export function disposeMeshLoDRequestScheduler(scheduler: MeshLoDRequestScheduler): void {
    for (const request of [...scheduler.requests.values()]) {
        cancelRequest(scheduler, request);
    }
    scheduler.requests.clear();
    scheduler.inFlightCount = 0;
}

// ─── Internals ───────────────────────────────────────────────────────

function pickQueued(scheduler: MeshLoDRequestScheduler): MeshLoDPageRequest | null {
    let best: MeshLoDPageRequest | null = null;
    for (const request of scheduler.requests.values()) {
        if (request.state !== "queued") {
            continue;
        }
        if (!best || request.priority > best.priority || (request.priority === best.priority && request.pageId < best.pageId)) {
            best = request;
        }
    }
    return best;
}

function startRequest(scheduler: MeshLoDRequestScheduler, request: MeshLoDPageRequest): void {
    const token = ++scheduler.nextToken;
    request.token = token;
    request.generation = scheduler.callbacks.currentGeneration();
    request.state = "fetching";
    request.cancelled = false;
    const controller = new AbortController();
    request.controller = controller;
    scheduler.inFlightCount++;
    void scheduler.callbacks.fetchPage(request.pageId, controller.signal).then(
        (bytes) => handleSuccess(scheduler, request, token, bytes),
        (error: unknown) => handleError(scheduler, request, token, error)
    );
}

/** Release the in-flight slot for a completing transfer exactly once. Returns whether
 *  the completion is fresh (should be acted on) or stale (must be discarded). */
function settleFetching(scheduler: MeshLoDRequestScheduler, request: MeshLoDPageRequest, token: number): boolean {
    if (request.state === "fetching") {
        scheduler.inFlightCount--;
        request.controller = null;
    }
    return !request.cancelled && request.token === token && request.generation === scheduler.callbacks.currentGeneration() && scheduler.requests.get(request.pageId) === request;
}

function handleSuccess(scheduler: MeshLoDRequestScheduler, request: MeshLoDPageRequest, token: number, bytes: Uint8Array): void {
    const fresh = settleFetching(scheduler, request, token);
    if (!fresh) {
        discardStale(scheduler, request);
        pumpMeshLoDScheduler(scheduler);
        return;
    }
    scheduler.requests.delete(request.pageId);
    scheduler.callbacks.onPageReceived(request.pageId, bytes, request);
    pumpMeshLoDScheduler(scheduler);
}

function handleError(scheduler: MeshLoDRequestScheduler, request: MeshLoDPageRequest, token: number, error: unknown): void {
    const fresh = settleFetching(scheduler, request, token);
    if (!fresh) {
        discardStale(scheduler, request);
        pumpMeshLoDScheduler(scheduler);
        return;
    }
    if (classifyRetryable(error) && request.attempt < scheduler.retryCount) {
        const delay = scheduler.retryDelaysMs[Math.min(request.attempt, scheduler.retryDelaysMs.length - 1)] ?? 0;
        request.attempt++;
        request.state = "retry-wait";
        request.retryTimer = scheduler.timers.setTimer(delay, () => onRetryTimer(scheduler, request));
        return;
    }
    scheduler.requests.delete(request.pageId);
    scheduler.callbacks.onPageFailed(request.pageId, asMeshLoDError(error), request);
    pumpMeshLoDScheduler(scheduler);
}

/** Drop a stale completion's dead map entry without disturbing a fresh re-demand that
 *  may have re-created a different request for the same page id. */
function discardStale(scheduler: MeshLoDRequestScheduler, request: MeshLoDPageRequest): void {
    if (scheduler.requests.get(request.pageId) === request) {
        scheduler.requests.delete(request.pageId);
    }
}

function onRetryTimer(scheduler: MeshLoDRequestScheduler, request: MeshLoDPageRequest): void {
    request.retryTimer = null;
    if (request.cancelled || scheduler.requests.get(request.pageId) !== request) {
        return;
    }
    request.state = "queued";
    pumpMeshLoDScheduler(scheduler);
}

function pruneObsolete(scheduler: MeshLoDRequestScheduler): void {
    const cutoff = scheduler.frame - scheduler.obsoleteRequestGraceFrames;
    for (const request of [...scheduler.requests.values()]) {
        if (request.lastDemandFrame <= cutoff) {
            cancelRequest(scheduler, request);
        }
    }
}

/** Cancel a request: pending timers are cleared and the entry is removed immediately.
 *  A `fetching` transfer is aborted; its slot is released exactly once when the abort
 *  rejection lands (the removed record is then stale, so it cannot commit or resurrect
 *  even if the page is re-demanded meanwhile). */
function cancelRequest(scheduler: MeshLoDRequestScheduler, request: MeshLoDPageRequest): void {
    request.cancelled = true;
    if (request.retryTimer !== null) {
        scheduler.timers.clearTimer(request.retryTimer);
        request.retryTimer = null;
    }
    if (request.state === "fetching") {
        request.controller?.abort();
    }
    if (scheduler.requests.get(request.pageId) === request) {
        scheduler.requests.delete(request.pageId);
    }
}

function asMeshLoDError(error: unknown): MeshLoDError {
    return error as MeshLoDError;
}

/** Classify a fetch failure per architecture §11.2. Network failures (no status),
 *  408, 429, and 5xx are retryable; aborts, other 4xx, protocol, integrity, and
 *  version errors are permanent. Non-MeshLoD throwables are treated as transient. */
function classifyRetryable(error: unknown): boolean {
    if (!isMeshLoDError(error)) {
        return true;
    }
    switch (error.code) {
        case "MLOD_HTTP_STATUS": {
            const status = typeof error.actual === "number" ? error.actual : 0;
            return status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599);
        }
        case "MLOD_ABORTED":
        case "MLOD_HTTP_RANGE":
        case "MLOD_HTTP_ENCODING":
        case "MLOD_TRUNCATED":
        case "MLOD_BAD_MAGIC":
        case "MLOD_UNSUPPORTED_VERSION":
        case "MLOD_UNSUPPORTED_ENDIAN":
        case "MLOD_HEADER_INTEGRITY":
        case "MLOD_DIRECTORY_INTEGRITY":
        case "MLOD_SECTION_INTEGRITY":
        case "MLOD_PAGE_INTEGRITY":
        case "MLOD_INVALID_LAYOUT":
        case "MLOD_INVALID_HIERARCHY":
        case "MLOD_DECODER_LOAD":
        case "MLOD_DECODER_FAILURE":
            return false;
        default:
            return false;
    }
}
