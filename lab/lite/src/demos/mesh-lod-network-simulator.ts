// MeshLoD demo — network simulator.
//
// A `fetch`-compatible wrapper that delays and throttles ONLY `.mlod` range
// responses (architecture §15.3), so the demo can make streaming, residency, and
// coarse-fallback behaviour observable under constrained bandwidth/latency
// without touching the environment/GLB/texture traffic. It preserves status,
// headers (Content-Range/Content-Length/Accept-Ranges), and abort semantics so
// MeshLoD's strict range-protocol validation still sees a faithful response.
//
// The scheduler (`wait`) is injectable so the throttle/latency/abort behaviour is
// deterministically unit-testable without real timers.

/** `Infinity` bandwidth means unlimited (no throttling). */
export interface MeshLoDNetworkSettings {
    bandwidthBytesPerSecond: number;
    latencyMs: number;
    failureMode: MeshLoDNetworkFailureMode;
}

/** Fault injection for `.mlod` traffic (for the demo's coarse-fallback scenarios):
 *  `none` normal, `unavailable` rejects with a network error (retried → terminal),
 *  `corrupt` returns integrity-invalid bytes (immediate terminal failure). */
export type MeshLoDNetworkFailureMode = "none" | "unavailable" | "corrupt";

export interface MeshLoDNetworkSimulator {
    /** A drop-in `fetch` to pass as `MeshLoDRequestOptions.fetch`. */
    readonly fetch: typeof fetch;
    setBandwidthBytesPerSecond(bytesPerSecond: number): void;
    setLatencyMs(latencyMs: number): void;
    setFailureMode(mode: MeshLoDNetworkFailureMode): void;
    getSettings(): MeshLoDNetworkSettings;
}

export interface MeshLoDNetworkSimulatorOptions {
    bandwidthBytesPerSecond?: number;
    latencyMs?: number;
    failureMode?: MeshLoDNetworkFailureMode;
    /** Async delay that MUST reject on abort. Defaults to a `setTimeout` clock;
     *  tests inject a controllable one. */
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Body pacing granularity in bytes (default 65536). */
    chunkBytes?: number;
    /** Predicate for which requests to throttle (default: URL contains `.mlod`). */
    shouldThrottle?: (url: string) => boolean;
}

function abortError(): DOMException {
    return new DOMException("The operation was aborted.", "AbortError");
}

function defaultWait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        if (ms <= 0) {
            resolve();
            return;
        }
        const id = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(id);
            reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") {
        return input;
    }
    if (input instanceof URL) {
        return input.href;
    }
    return input.url;
}

function requestSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
    if (init?.signal) {
        return init.signal;
    }
    if (typeof Request !== "undefined" && input instanceof Request) {
        return input.signal;
    }
    return undefined;
}

/** Wrap a response body in a stream that releases bytes at the given rate. */
function throttleBody(
    source: ReadableStream<Uint8Array>,
    bytesPerSecond: number,
    chunkBytes: number,
    wait: (ms: number, signal?: AbortSignal) => Promise<void>,
    signal?: AbortSignal
): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    let pending: Uint8Array | null = null;
    let offset = 0;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                if (!pending || offset >= pending.byteLength) {
                    const { done, value } = await reader.read();
                    if (done) {
                        controller.close();
                        return;
                    }
                    pending = value;
                    offset = 0;
                }
                const end = Math.min(offset + chunkBytes, pending.byteLength);
                const slice = pending.subarray(offset, end);
                offset = end;
                await wait((slice.byteLength / bytesPerSecond) * 1000, signal);
                controller.enqueue(slice);
            } catch (err) {
                await reader.cancel(err).catch(() => undefined);
                controller.error(err);
            }
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
}

export function createMeshLoDNetworkSimulator(baseFetch: typeof fetch, options: MeshLoDNetworkSimulatorOptions = {}): MeshLoDNetworkSimulator {
    const settings: MeshLoDNetworkSettings = {
        bandwidthBytesPerSecond: options.bandwidthBytesPerSecond ?? Infinity,
        latencyMs: options.latencyMs ?? 0,
        failureMode: options.failureMode ?? "none",
    };
    const wait = options.wait ?? defaultWait;
    const chunkBytes = options.chunkBytes ?? 65536;
    const shouldThrottle = options.shouldThrottle ?? ((url: string) => url.includes(".mlod"));

    const fetchImpl: typeof fetch = async (input, init) => {
        const url = requestUrl(input);
        if (!shouldThrottle(url)) {
            return baseFetch(input, init);
        }
        const signal = requestSignal(input, init);
        const { bandwidthBytesPerSecond, latencyMs, failureMode } = settings;
        if (latencyMs > 0) {
            await wait(latencyMs, signal);
        }
        if (failureMode === "unavailable") {
            // A network-style error: retryable, so pages retry then terminally fail
            // while the pinned coarse geometry keeps rendering.
            throw new TypeError("MeshLoD network simulator: fine pages unavailable");
        }
        const response = await baseFetch(input, init);
        if (failureMode === "corrupt") {
            // Flip a byte so the page's CRC/integrity check fails → immediate terminal
            // failure (page-local), demonstrating the coarse fallback holds.
            const buffer = new Uint8Array(await response.arrayBuffer());
            if (buffer.length > 0) {
                buffer[buffer.length >> 1] = buffer[buffer.length >> 1]! ^ 0xff;
            }
            return new Response(buffer, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        if (!Number.isFinite(bandwidthBytesPerSecond) || !response.body) {
            return response;
        }
        const throttled = throttleBody(response.body, bandwidthBytesPerSecond, chunkBytes, wait, signal);
        return new Response(throttled, { status: response.status, statusText: response.statusText, headers: response.headers });
    };

    return {
        fetch: fetchImpl,
        setBandwidthBytesPerSecond(bytesPerSecond: number): void {
            settings.bandwidthBytesPerSecond = bytesPerSecond;
        },
        setLatencyMs(latencyMs: number): void {
            settings.latencyMs = latencyMs;
        },
        setFailureMode(mode: MeshLoDNetworkFailureMode): void {
            settings.failureMode = mode;
        },
        getSettings(): MeshLoDNetworkSettings {
            return { ...settings };
        },
    };
}
