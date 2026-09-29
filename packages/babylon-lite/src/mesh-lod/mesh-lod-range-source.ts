/** MeshLoD range source — reads byte ranges from a URL, `ArrayBuffer`, or `Blob`.
 *
 *  In-memory sources (`ArrayBuffer`/`Blob`, or a retained full HTTP 200 body) are
 *  complete files served by slicing. URL sources issue HTTP `Range` requests and
 *  strictly validate the protocol: identity encoding only, exact `Content-Range`,
 *  matching body length and total, and explicit failure for multipart, 304,
 *  transformed, mismatched, or unusable responses. A full-body 200 is retained so
 *  later reads never re-download. Caller `fetch`, `headers`, and `credentials` are
 *  merged without mutating the caller's inputs. */

import type { MeshLoDRequestOptions, MeshLoDSource } from "./mesh-lod.js";
import { createMeshLoDError } from "./mesh-lod-errors.js";

/** First bootstrap read spans the header + directory (+ often all metadata). */
export const BOOTSTRAP_FIRST_END = 65535;

export interface MeshLoDRangeSource {
    /** Declared total file size once known (immediately for in-memory sources). */
    readonly totalBytes: number | null;
    /** The whole file when it is resident in memory, else `null`. */
    readonly completeBytes: Uint8Array | null;
    /** Total network bytes transferred so far (`0` for in-memory sources). */
    readonly downloadedBytes: number;
    /** Read the inclusive byte range `[start, end]`. Returns exactly the requested
     *  bytes, or fewer only when the range reaches end of file. */
    read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/** @internal Throw `MLOD_ABORTED` if the signal is already aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw createMeshLoDError("MLOD_ABORTED", "operation aborted");
    }
}

function isAbortError(cause: unknown): boolean {
    return typeof cause === "object" && cause !== null && (cause as { name?: unknown }).name === "AbortError";
}

function sliceRange(bytes: Uint8Array, start: number, end: number): Uint8Array {
    const clampedEnd = Math.min(end, bytes.length - 1);
    if (start < 0 || start > clampedEnd) {
        throw createMeshLoDError("MLOD_INVALID_LAYOUT", "requested range is outside the file", { expected: bytes.length, actual: start });
    }
    return bytes.subarray(start, clampedEnd + 1);
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
    if (!value) {
        return null;
    }
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(value.trim());
    if (!match) {
        return null;
    }
    return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

function createMemorySource(bytes: Uint8Array): MeshLoDRangeSource {
    return {
        totalBytes: bytes.length,
        completeBytes: bytes,
        downloadedBytes: 0,
        read(start, end, signal) {
            throwIfAborted(signal);
            return Promise.resolve(sliceRange(bytes, start, end));
        },
    };
}

function createUrlSource(url: string, request: MeshLoDRequestOptions | undefined): MeshLoDRangeSource {
    const fetchImpl = request?.fetch ?? globalThis.fetch;
    let totalBytes: number | null = null;
    let completeBytes: Uint8Array | null = null;
    let downloadedBytes = 0;

    async function read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
        throwIfAborted(signal);
        if (completeBytes) {
            return sliceRange(completeBytes, start, end);
        }
        const headers = new Headers(request?.headers);
        headers.set("Range", `bytes=${start}-${end}`);
        const init: RequestInit = { headers, signal };
        if (request?.credentials !== undefined) {
            init.credentials = request.credentials;
        }

        let response: Response;
        try {
            response = await fetchImpl(url, init);
        } catch (cause) {
            if (isAbortError(cause) || signal?.aborted) {
                throw createMeshLoDError("MLOD_ABORTED", "range request aborted", { url, cause });
            }
            throw createMeshLoDError("MLOD_HTTP_STATUS", "range request failed", { url, cause });
        }

        const encoding = response.headers.get("Content-Encoding");
        if (encoding && encoding.toLowerCase() !== "identity") {
            throw createMeshLoDError("MLOD_HTTP_ENCODING", "response used a non-identity content encoding", { url, actual: encoding });
        }

        if (response.status === 206) {
            const contentType = (response.headers.get("Content-Type") ?? "").toLowerCase();
            if (contentType.includes("multipart/byteranges")) {
                throw createMeshLoDError("MLOD_HTTP_RANGE", "multipart range responses are not supported", { url });
            }
            const range = parseContentRange(response.headers.get("Content-Range"));
            if (!range) {
                throw createMeshLoDError("MLOD_HTTP_RANGE", "missing or malformed Content-Range", { url });
            }
            if (range.start !== start || range.end > end || range.end < range.start) {
                throw createMeshLoDError("MLOD_HTTP_RANGE", "Content-Range does not match the request", {
                    url,
                    expected: `${start}-${end}`,
                    actual: `${range.start}-${range.end}`,
                });
            }
            if (totalBytes !== null && totalBytes !== range.total) {
                throw createMeshLoDError("MLOD_HTTP_RANGE", "Content-Range total changed between requests", { url, expected: totalBytes, actual: range.total });
            }
            const body = new Uint8Array(await response.arrayBuffer());
            if (body.length !== range.end - range.start + 1) {
                throw createMeshLoDError("MLOD_HTTP_RANGE", "response length disagrees with Content-Range", { url, expected: range.end - range.start + 1, actual: body.length });
            }
            totalBytes = range.total;
            downloadedBytes += body.length;
            return body;
        }

        if (response.status === 200) {
            const body = new Uint8Array(await response.arrayBuffer());
            downloadedBytes += body.length;
            if (totalBytes !== null && totalBytes !== body.length) {
                throw createMeshLoDError("MLOD_HTTP_RANGE", "full response length disagrees with the known total", { url, expected: totalBytes, actual: body.length });
            }
            totalBytes = body.length;
            completeBytes = body;
            return sliceRange(body, start, end);
        }

        if (response.status === 304) {
            throw createMeshLoDError("MLOD_HTTP_STATUS", "unexpected 304 Not Modified", { url, actual: 304 });
        }
        throw createMeshLoDError("MLOD_HTTP_STATUS", "unexpected response status", { url, actual: response.status });
    }

    return {
        get totalBytes(): number | null {
            return totalBytes;
        },
        get completeBytes(): Uint8Array | null {
            return completeBytes;
        },
        get downloadedBytes(): number {
            return downloadedBytes;
        },
        read,
    };
}

/** Create a range source for a URL, `ArrayBuffer`, or `Blob`. `ArrayBuffer`/`Blob`
 *  inputs are materialized as complete-file sources; a `Blob` is read fully into
 *  memory. */
export async function createMeshLoDRangeSource(source: MeshLoDSource, request?: MeshLoDRequestOptions): Promise<MeshLoDRangeSource> {
    if (typeof source === "string") {
        return createUrlSource(source, request);
    }
    if (source instanceof Blob) {
        return createMemorySource(new Uint8Array(await source.arrayBuffer()));
    }
    return createMemorySource(new Uint8Array(source));
}

/** Concatenate two byte ranges into a contiguous buffer. */
export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
