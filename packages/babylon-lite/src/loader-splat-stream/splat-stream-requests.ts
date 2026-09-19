import { BU, TU } from "../engine/gpu-flags.js";
import { parseLooseSogV2Metadata, validateLooseSogV2Images } from "./splat-stream-meta.js";
import type { SogInterval } from "./splat-stream-types.js";
import type { SplatStreamGpuLedger } from "./splat-stream-gpu-ledger.js";

const PREFIX = "[GaussianSplatStream]";
const METADATA_BYTES = 2048;

class TransientHttpError extends Error {}

/** @internal Lower values run first. */
export const enum SplatRequestPriority {
    Bootstrap = 0,
    Uncovered = 1,
    Upgrade = 2,
    Environment = 3,
    Prefetch = 4,
}

/** @internal */
export interface SplatSourceRequest {
    readonly url: string;
    readonly fileId: number;
    readonly generation: number;
    readonly priority: SplatRequestPriority;
    readonly intervals: readonly SogInterval[];
    readonly signal?: AbortSignal;
}

/** @internal */
export interface PreparedSplatSource {
    readonly url: string;
    readonly fileId: number;
    readonly generation: number;
    readonly width: number;
    readonly height: number;
    readonly count: number;
    readonly textures: readonly GPUTexture[];
    readonly metadataBuffer: GPUBuffer;
    readonly meansMin: Float32Array;
    readonly meansMax: Float32Array;
    readonly gpuBytes: number;
    readonly cpuBytes: number;
    /** @internal Transport reservation transferred to the source cache on success. */
    readonly _gpuReserved?: boolean;
}

/** @internal */
export interface SplatStreamRequestDependencies {
    readonly device: GPUDevice;
    readonly fetch?: typeof globalThis.fetch;
    readonly decode?: (blob: Blob, options: ImageBitmapOptions) => Promise<ImageBitmap>;
    readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    readonly isGenerationCurrent?: (url: string, generation: number) => boolean;
    readonly gpuLedger?: SplatStreamGpuLedger;
    readonly reserveGpuBytes?: (url: string, bytes: number) => boolean;
}

/** @internal A valid source preparation deferred solely by the shared GPU allocation budget. */
export class SplatGpuBudgetPressureError extends Error {
    constructor(
        readonly url: string,
        readonly requiredBytes: number
    ) {
        super(`${PREFIX} source ${url}: waiting for ${requiredBytes} GPU bytes`);
        this.name = "SplatGpuBudgetPressureError";
    }
}

/** @internal */
export interface SplatStreamRequestManager {
    readonly cpuBytes: number;
    readonly fetchedBytes: number;
    readonly pendingRequests: number;
    readonly queuedFiles: number;
    readonly disposed: boolean;
    request(request: SplatSourceRequest): Promise<PreparedSplatSource>;
    cancel(url: string): void;
    dispose(): void;
}

interface RequestJob {
    request: SplatSourceRequest;
    readonly intervals: SogInterval[];
    sequence: number;
    controller: AbortController;
    resolve: (source: PreparedSplatSource) => void;
    reject: (reason: unknown) => void;
    promise: Promise<PreparedSplatSource>;
    state: "queued" | "active";
    detachSignal?: () => void;
}

interface Waiter {
    readonly run: () => void;
    readonly reject: (reason: unknown) => void;
    readonly signal: AbortSignal;
}

interface CpuWaiter {
    readonly bytes: number;
    readonly resolve: () => void;
    readonly reject: (reason: unknown) => void;
    readonly signal: AbortSignal;
}

function abortError(): DOMException {
    return new DOMException("The operation was aborted", "AbortError");
}

function asError(reason: unknown): Error {
    return reason instanceof Error ? reason : abortError();
}

function defaultDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(asError(signal.reason));
            return;
        }
        const timer = setTimeout(resolve, milliseconds);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(asError(signal.reason));
            },
            { once: true }
        );
    });
}

function jitter(fileId: number, attempt: number): number {
    let value = (fileId + 1) * 0x9e3779b1 + (attempt + 1) * 0x85ebca6b;
    value ^= value >>> 16;
    return value & 63;
}

function transientStatus(status: number): boolean {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

function contentLength(response: Response, url: string): number | null {
    const value = response.headers.get("content-length");
    if (value === null) {
        return null;
    }
    if (!/^(0|[1-9]\d*)$/.test(value)) {
        throw new Error(`${PREFIX} transport ${url}: invalid Content-Length`);
    }
    const length = Number(value);
    if (!Number.isSafeInteger(length)) {
        throw new Error(`${PREFIX} transport ${url}: unsafe Content-Length`);
    }
    return length;
}

function webpDimensions(bytes: Uint8Array, url: string): { width: number; height: number } {
    const u24 = (offset: number): number => bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
    if (bytes.length < 30 || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP") {
        throw new Error(`${PREFIX} image ${url}: invalid WebP header`);
    }
    const kind = String.fromCharCode(...bytes.subarray(12, 16));
    if (kind === "VP8X") {
        return { width: 1 + u24(24), height: 1 + u24(27) };
    }
    if (kind === "VP8L") {
        if (bytes[20] !== 0x2f) {
            throw new Error(`${PREFIX} image ${url}: invalid lossless WebP header`);
        }
        const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return { width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff, height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff };
    }
    throw new Error(`${PREFIX} image ${url}: unsupported WebP header`);
}

function destroyPrepared(source: PreparedSplatSource): void {
    for (const texture of source.textures) {
        texture.destroy();
    }
    source.metadataBuffer.destroy();
}

/** @internal Creates a per-stream scheduler. All queues and dedupe maps are instance-owned. */
export function createSplatStreamRequestManager(
    maxConcurrentRequests: number,
    maxConcurrentDecodes: number,
    maxCpuBytes: number,
    maxRetries: number,
    dependencies: SplatStreamRequestDependencies
): SplatStreamRequestManager {
    const fetchImpl = dependencies.fetch ?? globalThis.fetch;
    const decode = dependencies.decode ?? ((blob, options) => globalThis.createImageBitmap(blob, options));
    const delay = dependencies.delay ?? defaultDelay;
    if (!fetchImpl || !decode) {
        throw new Error(`${PREFIX} transport: Fetch and createImageBitmap are required`);
    }
    if (dependencies.reserveGpuBytes && !dependencies.gpuLedger) {
        throw new Error(`${PREFIX} transport: reserveGpuBytes requires gpuLedger for reservation cleanup`);
    }
    if (
        !Number.isSafeInteger(maxConcurrentRequests) ||
        maxConcurrentRequests <= 0 ||
        !Number.isSafeInteger(maxConcurrentDecodes) ||
        maxConcurrentDecodes <= 0 ||
        !Number.isSafeInteger(maxCpuBytes) ||
        maxCpuBytes <= 0 ||
        !Number.isSafeInteger(maxRetries) ||
        maxRetries < 0
    ) {
        throw new RangeError(`${PREFIX} transport: invalid limits`);
    }

    const jobs = new Map<string, RequestJob>();
    const activeUrls = new Set<string>();
    const queue: RequestJob[] = [];
    const httpWaiters: Waiter[] = [];
    const decodeWaiters: Waiter[] = [];
    const payloadWaiters: Waiter[] = [];
    const cpuWaiters: CpuWaiter[] = [];
    let sequence = 0;
    let activePreparations = 0;
    let activeHttp = 0;
    let activeDecodes = 0;
    let activePayload = false;
    let cpuBytes = 0;
    let fetchedBytes = 0;
    let disposed = false;

    const runLimited = <T>(limit: number, kind: "http" | "decode", signal: AbortSignal, operation: () => Promise<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            const waiters = kind === "http" ? httpWaiters : decodeWaiters;
            const run = (): void => {
                if (signal.aborted || disposed) {
                    reject(asError(signal.reason));
                    return;
                }
                if (kind === "http") {
                    activeHttp++;
                } else {
                    activeDecodes++;
                }
                void operation()
                    .then(resolve, reject)
                    .finally(() => {
                        if (kind === "http") {
                            activeHttp--;
                        } else {
                            activeDecodes--;
                        }
                        while (waiters.length > 0) {
                            const next = waiters.shift()!;
                            if (!next.signal.aborted) {
                                next.run();
                                break;
                            }
                            next.reject(asError(next.signal.reason));
                        }
                    });
            };
            const active = kind === "http" ? activeHttp : activeDecodes;
            if (active < limit) {
                run();
            } else {
                const waiter: Waiter = { run, reject, signal };
                waiters.push(waiter);
            }
        });
    const acquirePayload = (signal: AbortSignal): Promise<void> =>
        new Promise<void>((resolve, reject) => {
            const abort = (): void => {
                const index = payloadWaiters.indexOf(waiter);
                if (index >= 0) {
                    payloadWaiters.splice(index, 1);
                }
                reject(asError(signal.reason));
            };
            const run = (): void => {
                signal.removeEventListener("abort", abort);
                if (signal.aborted || disposed) {
                    reject(asError(signal.reason));
                    return;
                }
                activePayload = true;
                resolve();
            };
            const waiter: Waiter = {
                run,
                signal,
                reject: (reason) => {
                    signal.removeEventListener("abort", abort);
                    reject(reason instanceof Error ? reason : asError(reason));
                },
            };
            if (!activePayload) {
                run();
            } else {
                payloadWaiters.push(waiter);
                if (signal.aborted) {
                    abort();
                } else {
                    signal.addEventListener("abort", abort, { once: true });
                }
            }
        });
    const releasePayload = (): void => {
        activePayload = false;
        while (payloadWaiters.length > 0) {
            const next = payloadWaiters.shift()!;
            if (!next.signal.aborted) {
                next.run();
                break;
            }
            next.reject(asError(next.signal.reason));
        }
    };

    const pumpCpu = (): void => {
        for (let index = 0; index < cpuWaiters.length;) {
            const waiter = cpuWaiters[index]!;
            if (waiter.signal.aborted || disposed) {
                cpuWaiters.splice(index, 1);
                waiter.reject(asError(waiter.signal.reason));
            } else if (cpuBytes + waiter.bytes <= maxCpuBytes) {
                cpuWaiters.splice(index, 1);
                cpuBytes += waiter.bytes;
                waiter.resolve();
            } else {
                index++;
            }
        }
    };
    const reserve = (bytes: number, context: string, signal: AbortSignal): Promise<void> => {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxCpuBytes) {
            throw new Error(`${PREFIX} ${context}: maxCpuBytes cannot admit ${bytes} bytes`);
        }
        if (cpuBytes + bytes <= maxCpuBytes) {
            cpuBytes += bytes;
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const abort = (): void => {
                const index = cpuWaiters.indexOf(waiter);
                if (index >= 0) {
                    cpuWaiters.splice(index, 1);
                }
                reject(asError(signal.reason));
            };
            const waiter: CpuWaiter = {
                bytes,
                signal,
                resolve: () => {
                    signal.removeEventListener("abort", abort);
                    resolve();
                },
                reject: (reason) => {
                    signal.removeEventListener("abort", abort);
                    reject(reason instanceof Error ? reason : asError(reason));
                },
            };
            cpuWaiters.push(waiter);
            if (signal.aborted) {
                abort();
            } else {
                signal.addEventListener("abort", abort, { once: true });
            }
        });
    };
    const reserveOwned = async (bytes: number, ownedBytes: number, context: string, signal: AbortSignal): Promise<void> => {
        if (!Number.isSafeInteger(ownedBytes) || ownedBytes < 0 || ownedBytes + bytes > maxCpuBytes) {
            throw new Error(`${PREFIX} ${context}: maxCpuBytes cannot admit ${bytes} bytes without blocking payloads retained by the same preparation`);
        }
        await reserve(bytes, context, signal);
    };
    const release = (bytes: number): void => {
        cpuBytes -= bytes;
        pumpCpu();
    };
    interface FetchedBody {
        readonly blob: Blob;
        readonly header: Uint8Array;
        readonly mimeType: string;
        readonly bytes: number;
        release(): void;
    }
    const fetchWithRetry = async (url: string, fileId: number, signal: AbortSignal, retainedBytes = (): number => 0): Promise<FetchedBody> => {
        for (let attempt = 0; ; attempt++) {
            try {
                return await runLimited(maxConcurrentRequests, "http", signal, async () => {
                    const response = await fetchImpl(url, { signal });
                    if (!response.ok) {
                        if (response.body) {
                            await response.body.cancel();
                        }
                        const error = new Error(`${PREFIX} transport ${url}: HTTP ${response.status}`);
                        if (!transientStatus(response.status) || attempt >= maxRetries) {
                            throw error;
                        }
                        throw new TransientHttpError(error.message);
                    }
                    const declared = contentLength(response, url);
                    try {
                        if (declared !== null) {
                            await reserveOwned(declared, retainedBytes(), `response ${url}`, signal);
                        }
                    } catch (reason) {
                        await response.body?.cancel();
                        throw reason;
                    }
                    let reserved = declared ?? 0;
                    let total = 0;
                    let released = false;
                    const chunks: Uint8Array<ArrayBuffer>[] = [];
                    try {
                        if (!response.body) {
                            throw new Error(`${PREFIX} transport ${url}: response has no body`);
                        }
                        const reader = response.body.getReader();
                        try {
                            for (;;) {
                                const part = await reader.read();
                                if (part.done) {
                                    break;
                                }
                                if (part.value.byteLength === 0) {
                                    continue;
                                }
                                if (total + part.value.byteLength > reserved) {
                                    const extra = total + part.value.byteLength - reserved;
                                    await reserveOwned(extra, retainedBytes() + reserved, `streamed response ${url}`, signal);
                                    reserved += extra;
                                }
                                total += part.value.byteLength;
                                chunks.push(new Uint8Array(part.value));
                            }
                        } finally {
                            reader.releaseLock();
                        }
                        if (reserved > total) {
                            release(reserved - total);
                            reserved = total;
                        }
                        fetchedBytes += total;
                        const header = new Uint8Array(Math.min(total, 64));
                        let headerOffset = 0;
                        for (const chunk of chunks) {
                            const count = Math.min(chunk.byteLength, header.byteLength - headerOffset);
                            header.set(chunk.subarray(0, count), headerOffset);
                            headerOffset += count;
                            if (headerOffset === header.byteLength) {
                                break;
                            }
                        }
                        return {
                            blob: new Blob(chunks, { type: response.headers.get("content-type") ?? "" }),
                            header,
                            mimeType: response.headers.get("content-type") ?? "",
                            bytes: reserved,
                            release(): void {
                                if (!released) {
                                    released = true;
                                    release(reserved);
                                }
                            },
                        };
                    } catch (reason) {
                        release(reserved);
                        throw reason;
                    }
                });
            } catch (error) {
                if (signal.aborted) {
                    throw signal.reason ?? abortError();
                }
                if (error instanceof TransientHttpError) {
                    // Retry below.
                } else if (error instanceof Error && error.message.startsWith(PREFIX)) {
                    throw error;
                } else if (attempt >= maxRetries) {
                    throw new Error(`${PREFIX} transport ${url}: network request failed`, { cause: error });
                }
            }
            await delay(Math.min(2000, 125 * 2 ** attempt) + jitter(fileId, attempt), signal);
        }
    };

    const readJson = async (url: string, fileId: number, signal: AbortSignal): Promise<unknown> => {
        const body = await fetchWithRetry(url, fileId, signal);
        try {
            return JSON.parse(await body.blob.text()) as unknown;
        } catch (error) {
            throw new Error(`${PREFIX} metadata ${url}: invalid JSON`, { cause: error });
        } finally {
            body.release();
        }
    };

    const prepare = async (job: RequestJob, signal: AbortSignal): Promise<PreparedSplatSource> => {
        const request = job.request;
        await acquirePayload(signal);
        const bitmaps: ImageBitmap[] = [];
        const textures: GPUTexture[] = [];
        const mimeTypes: string[] = [];
        let decodedBytes = 0;
        let reservedDecodedBytes = 0;
        let metadataBuffer: GPUBuffer | null = null;
        let gpuReserved = false;
        try {
            const metadata = parseLooseSogV2Metadata(await readJson(request.url, request.fileId, signal), request.url);
            for (const imageUrl of metadata.imageUrls) {
                const body = await fetchWithRetry(imageUrl, request.fileId, signal, () => reservedDecodedBytes);
                mimeTypes.push(body.mimeType);
                let bitmap: ImageBitmap;
                try {
                    const dimensions = webpDimensions(body.header, imageUrl);
                    const bitmapReservation = dimensions.width * dimensions.height * 4;
                    if (bitmaps.length === 0) {
                        const totalDecodedBytes = bitmapReservation * metadata.imageUrls.length;
                        validateLooseSogV2Images(
                            metadata,
                            metadata.imageUrls.map((url) => ({ ...dimensions, mimeType: "image/webp", url })),
                            maxCpuBytes,
                            job.intervals
                        );
                        await reserveOwned(totalDecodedBytes, body.bytes, `decoded images ${request.url}`, signal);
                        reservedDecodedBytes = totalDecodedBytes;
                    } else if (dimensions.width !== bitmaps[0]!.width || dimensions.height !== bitmaps[0]!.height) {
                        throw new Error(`${PREFIX} image ${imageUrl}: dimensions do not match the source`);
                    }
                    bitmap = await runLimited(maxConcurrentDecodes, "decode", signal, () =>
                        decode(body.blob, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "none" })
                    );
                } finally {
                    body.release();
                }
                const bitmapBytes = bitmap.width * bitmap.height * 4;
                decodedBytes += bitmapBytes;
                bitmaps.push(bitmap);
            }
            validateLooseSogV2Images(
                metadata,
                bitmaps.map((bitmap, index) => ({ width: bitmap.width, height: bitmap.height, mimeType: mimeTypes[index], url: metadata.imageUrls[index] })),
                maxCpuBytes,
                job.intervals
            );
            if (signal.aborted || disposed || dependencies.isGenerationCurrent?.(request.url, request.generation) === false) {
                throw signal.reason ?? abortError();
            }
            const gpuBytes = decodedBytes + METADATA_BYTES;
            const reserved = dependencies.reserveGpuBytes?.(request.url, gpuBytes) ?? dependencies.gpuLedger?.tryReserve(gpuBytes) ?? true;
            if (!reserved) {
                throw new SplatGpuBudgetPressureError(request.url, gpuBytes);
            }
            gpuReserved = !!dependencies.gpuLedger || !!dependencies.reserveGpuBytes;
            for (const bitmap of bitmaps) {
                const texture = dependencies.device.createTexture({
                    size: { width: bitmap.width, height: bitmap.height },
                    format: "rgba8unorm",
                    usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.RENDER_ATTACHMENT,
                });
                textures.push(texture);
                dependencies.device.queue.copyExternalImageToTexture(
                    { source: bitmap, flipY: false },
                    { texture, premultipliedAlpha: false },
                    { width: bitmap.width, height: bitmap.height }
                );
            }
            metadataBuffer = dependencies.device.createBuffer({ size: METADATA_BYTES, usage: BU.STORAGE | BU.COPY_DST });
            const values = new Float32Array(512);
            values.set(metadata.scaleCodebook, 0);
            values.set(metadata.sh0Codebook, 256);
            dependencies.device.queue.writeBuffer(metadataBuffer, 0, values);
            const result: PreparedSplatSource = {
                url: request.url,
                fileId: request.fileId,
                generation: request.generation,
                width: bitmaps[0]!.width,
                height: bitmaps[0]!.height,
                count: metadata.count,
                textures,
                metadataBuffer,
                meansMin: metadata.meansMin,
                meansMax: metadata.meansMax,
                gpuBytes,
                cpuBytes: 0,
                _gpuReserved: gpuReserved,
            };
            if (signal.aborted || disposed || dependencies.isGenerationCurrent?.(request.url, request.generation) === false) {
                throw signal.reason ?? abortError();
            }
            return result;
        } catch (error) {
            for (const texture of textures) {
                texture.destroy();
            }
            metadataBuffer?.destroy();
            if (gpuReserved) {
                dependencies.gpuLedger!.release(decodedBytes + METADATA_BYTES);
            }
            throw error;
        } finally {
            for (const bitmap of bitmaps) {
                bitmap.close();
            }
            release(reservedDecodedBytes);
            releasePayload();
        }
    };

    const pump = (): void => {
        if (disposed) {
            return;
        }
        queue.sort((a, b) => a.request.priority - b.request.priority || a.sequence - b.sequence);
        while (activePreparations < 1 && queue.length > 0) {
            const index = queue.findIndex((candidate) => !activeUrls.has(candidate.request.url));
            if (index < 0) {
                break;
            }
            const job = queue.splice(index, 1)[0]!;
            if (job.controller.signal.aborted) {
                continue;
            }
            job.state = "active";
            activeUrls.add(job.request.url);
            activePreparations++;
            void prepare(job, job.controller.signal)
                .then((source) => {
                    if (jobs.get(job.request.url) !== job) {
                        destroyPrepared(source);
                        throw abortError();
                    }
                    jobs.delete(job.request.url);
                    job.detachSignal?.();
                    job.resolve(source);
                })
                .catch((error: unknown) => {
                    if (jobs.get(job.request.url) === job) {
                        jobs.delete(job.request.url);
                    }
                    job.detachSignal?.();
                    job.reject(asError(error));
                })
                .finally(() => {
                    activeUrls.delete(job.request.url);
                    activePreparations--;
                    pump();
                });
        }
    };

    const manager: SplatStreamRequestManager = {
        get cpuBytes() {
            return cpuBytes;
        },
        get pendingRequests() {
            return activeHttp;
        },
        get fetchedBytes() {
            return fetchedBytes;
        },
        get queuedFiles() {
            return queue.length;
        },
        get disposed() {
            return disposed;
        },
        request(request) {
            if (disposed) {
                return Promise.reject(new Error(`${PREFIX} transport: disposed`));
            }
            let url: string;
            try {
                url = new URL(request.url).href;
            } catch {
                return Promise.reject(new Error(`${PREFIX} transport: invalid source URL`));
            }
            const normalized = { ...request, url };
            const existing = jobs.get(url);
            if (existing) {
                if (existing.request.generation === normalized.generation) {
                    for (const interval of normalized.intervals) {
                        if (!existing.intervals.some((value) => value.offset === interval.offset && value.count === interval.count)) {
                            existing.intervals.push(interval);
                        }
                    }
                    existing.request = { ...existing.request, priority: Math.min(existing.request.priority, normalized.priority) };
                    pump();
                    return existing.promise;
                }
                existing.controller.abort(abortError());
                existing.detachSignal?.();
                const queuedIndex = queue.indexOf(existing);
                if (queuedIndex >= 0) {
                    queue.splice(queuedIndex, 1);
                    jobs.delete(url);
                    existing.reject(abortError());
                }
            }
            let resolve!: (source: PreparedSplatSource) => void;
            let reject!: (reason: unknown) => void;
            const promise = new Promise<PreparedSplatSource>((res, rej) => {
                resolve = res;
                reject = rej;
            });
            const job: RequestJob = {
                request: normalized,
                intervals: [...normalized.intervals],
                sequence: sequence++,
                controller: new AbortController(),
                resolve,
                reject,
                promise,
                state: "queued",
            };
            if (request.signal) {
                if (request.signal.aborted) {
                    return Promise.reject(asError(request.signal.reason));
                }
                const abort = (): void => {
                    if (jobs.get(url) !== job) {
                        return;
                    }
                    job.controller.abort(abortError());
                    if (job.state === "queued") {
                        queue.splice(queue.indexOf(job), 1);
                        jobs.delete(url);
                        job.detachSignal?.();
                        job.reject(abortError());
                    }
                };
                request.signal.addEventListener("abort", abort, { once: true });
                job.detachSignal = () => request.signal!.removeEventListener("abort", abort);
            }
            jobs.set(url, job);
            queue.push(job);
            pump();
            return promise;
        },
        cancel(rawUrl) {
            let url: string;
            try {
                url = new URL(rawUrl).href;
            } catch {
                return;
            }
            const job = jobs.get(url);
            if (!job) {
                return;
            }
            job.controller.abort(abortError());
            if (job.state === "queued") {
                queue.splice(queue.indexOf(job), 1);
                jobs.delete(url);
                job.detachSignal?.();
                job.reject(abortError());
            }
        },
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            for (const job of jobs.values()) {
                job.controller.abort(abortError());
                job.detachSignal?.();
                if (job.state === "queued") {
                    job.reject(abortError());
                }
            }
            jobs.clear();
            queue.length = 0;
            for (const waiter of [...httpWaiters, ...decodeWaiters, ...payloadWaiters]) {
                waiter.reject(abortError());
            }
            httpWaiters.length = 0;
            decodeWaiters.length = 0;
            payloadWaiters.length = 0;
            for (const waiter of cpuWaiters) {
                waiter.reject(abortError());
            }
            cpuWaiters.length = 0;
        },
    };
    return manager;
}
