/** Deterministic, instrumented range server for MeshLoD streaming/cache fixtures
 *  (Task 6.4).
 *
 *  Backs the real statue `.mlod` file and applies per-page policies to fine-page ranges
 *  so a single fixture can reproduce delay, retry-status sequences, abort races, an HTTP
 *  200 full-body fallback, a malformed 206 (protocol error), and a CRC/integrity failure
 *  — all without a network or wall-clock timing. It records request starts, completions,
 *  and aborts and tracks peak concurrency so tests can assert the scheduler's bounded
 *  concurrency, deduplication, and cancellation invariants (REQ-STREAM-2..4/6). Coarse
 *  bootstrap ranges are always served verbatim. */

/** First byte of the first fine (non-pinned) page in the committed statue asset. */
export const STATUE_FINE_FLOOR = 262144;

export interface FakeFinePolicy {
    /** HTTP status per attempt for this page; the last entry repeats. Default `[206]`.
     *  `408`/`429`/`500` are retryable, `404` permanent. */
    readonly attempts?: readonly number[];
    /** Emit a 206 whose `Content-Range` disagrees with the request (protocol error). */
    readonly invalidContentRange?: boolean;
    /** Flip a byte so the delivered page fails its stored CRC (integrity error). */
    readonly corruptCrc?: boolean;
}

export interface FakeRangeServerOptions {
    /** Hold every fine-page response until {@link FakeRangeServer.release}; lets tests
     *  freeze transfers in flight to assert concurrency bounds and abort races. */
    readonly hold?: boolean;
    /** Answer the first request with a full 200 body instead of a 206 range, so the
     *  source retains the whole file and later reads never re-fetch. */
    readonly fullBody200?: boolean;
    /** Default policy for every fine page. */
    readonly finePolicy?: FakeFinePolicy;
    /** Per-page-start-offset policy overrides. */
    readonly perPage?: ReadonlyMap<number, FakeFinePolicy>;
}

export interface FakeRangeServer {
    readonly fetch: typeof globalThis.fetch;
    /** Every requested range start offset, in call order. */
    readonly starts: number[];
    /** Fine-page (>= fine floor) start offsets, in call order — for priority/order checks. */
    readonly fineStarts: number[];
    /** Successfully completed fine transfers (start offsets). */
    readonly completions: number[];
    /** Aborted fine transfers (start offsets). */
    readonly aborts: number[];
    /** Fine transfers currently in flight (started, not yet settled). */
    readonly inFlight: number;
    /** Peak simultaneous in-flight fine transfers observed. */
    readonly maxConcurrent: number;
    /** Number of held responses awaiting {@link release}. */
    heldCount(): number;
    /** Resolve every currently held response (delivering its policy status). */
    release(): void;
}

interface Held {
    readonly start: number;
    deliver(): void;
}

/** Create an instrumented range server over `file` (a valid `.mlod`). */
export function createFakeRangeServer(file: Uint8Array, options: FakeRangeServerOptions = {}): FakeRangeServer {
    const attemptCounts = new Map<number, number>();
    const held: Held[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    let served200 = false;

    const state = {
        starts: [] as number[],
        fineStarts: [] as number[],
        completions: [] as number[],
        aborts: [] as number[],
    };

    const policyFor = (start: number): FakeFinePolicy => options.perPage?.get(start) ?? options.finePolicy ?? {};

    const rangeResponse = (start: number, end: number, corrupt: boolean, invalid: boolean): Response => {
        const body = file.subarray(start, end + 1).slice();
        if (corrupt) {
            const mid = body.length >> 1;
            body[mid] = (body[mid] ?? 0) ^ 0xff; // break the page CRC without changing framing
        }
        const contentRange = invalid ? `bytes ${start + 1}-${end}/${file.length}` : `bytes ${start}-${end}/${file.length}`;
        return new Response(body.buffer as ArrayBuffer, { status: 206, headers: { "Content-Range": contentRange, "Content-Length": String(body.length) } });
    };

    const fullResponse = (): Response => new Response(file.slice().buffer as ArrayBuffer, { status: 200, headers: { "Content-Length": String(file.length) } });

    const settleStart = (): void => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
    };

    const fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const range = new Headers(init?.headers).get("Range");
        if (!range) {
            return fullResponse();
        }
        const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), file.length - 1);
        state.starts.push(start);

        if (start < STATUE_FINE_FLOOR) {
            return rangeResponse(start, end, false, false); // coarse bootstrap: always verbatim
        }
        state.fineStarts.push(start);

        if (options.fullBody200 && !served200) {
            served200 = true;
            return fullResponse();
        }

        const policy = policyFor(start);
        const attempt = attemptCounts.get(start) ?? 0;
        attemptCounts.set(start, attempt + 1);
        const attempts = policy.attempts ?? [206];
        const status = attempts[Math.min(attempt, attempts.length - 1)]!;

        const makeResponse = (): Response => {
            if (status !== 206) {
                return new Response(null, { status });
            }
            return rangeResponse(start, end, !!policy.corruptCrc, !!policy.invalidContentRange);
        };

        settleStart();
        const finish = (): void => {
            inFlight--;
        };

        if (!options.hold) {
            try {
                return makeResponse();
            } finally {
                finish();
                if (status === 206) {
                    state.completions.push(start);
                }
            }
        }

        return new Promise<Response>((resolve, reject) => {
            const item: Held = {
                start,
                deliver: () => {
                    finish();
                    if (status === 206) {
                        state.completions.push(start);
                    }
                    resolve(makeResponse());
                },
            };
            init?.signal?.addEventListener("abort", () => {
                const index = held.indexOf(item);
                if (index !== -1) {
                    held.splice(index, 1);
                    finish();
                    state.aborts.push(start);
                    reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                }
            });
            held.push(item);
        });
    }) as typeof globalThis.fetch;

    return {
        fetch,
        get starts(): number[] {
            return state.starts;
        },
        get fineStarts(): number[] {
            return state.fineStarts;
        },
        get completions(): number[] {
            return state.completions;
        },
        get aborts(): number[] {
            return state.aborts;
        },
        get inFlight(): number {
            return inFlight;
        },
        get maxConcurrent(): number {
            return maxConcurrent;
        },
        heldCount(): number {
            return held.length;
        },
        release(): void {
            const pending = held.splice(0);
            for (const item of pending) {
                item.deliver();
            }
        },
    };
}
