/** Opt-in KTX2/Basis transcoding in Web Workers.
 *
 *  The default KTX2 decoder (`ktx2-loader.ts`) transcodes on the main thread, so every KTX2 texture blocks the
 *  page for as long as its Basis transcode takes. `enableKtx2WorkerDecoding()` installs a decoder that runs the
 *  same Babylon KTX2 decoder script inside a small pool of dedicated workers: the main thread only copies the
 *  compressed bytes in and receives the transcoded mips back (transferred, not copied). Uploads, formats and
 *  the public loaders are unchanged — this module only replaces where `decode` runs.
 *
 *  Everything lives behind the enabler, so scenes that never call it pay nothing. If workers are unavailable or
 *  the decoder fails to initialise in one, the mode removes itself and the main-thread decoder takes over.
 */

import { _getKtx2DecoderUrls, _setKtx2DecoderSource, loadKtx2Decoder } from "./ktx2-loader.js";
import type { Ktx2DecodedData, Ktx2Decoder, Ktx2DecoderCaps } from "./ktx2-loader.js";

/** Options for {@link enableKtx2WorkerDecoding}. */
export interface Ktx2WorkerDecodingOptions {
    /** Number of decoding workers. Default: `hardwareConcurrency - 1`, clamped to [1, 4]. */
    workerCount?: number;
}

/** @internal Message posted to a decoding worker. */
export type Ktx2WorkerRequest =
    | { t: 0; url: string; wasmUrls: Record<string, Record<string, string>> | null }
    | { t: 1; id: number; data: Uint8Array; caps: Ktx2DecoderCaps; options?: { forceRGBA?: boolean } };

/** @internal Message posted back by a decoding worker (`e` carries an error message). */
export type Ktx2WorkerReply = { t: 0; e?: string } | { t: 1; id: number; d?: Ktx2DecodedData; e?: string };

/** @internal Body of each decoding worker. Self-contained: it runs in the worker realm, never in this module's,
 *  so it may only use worker globals (`importScripts`, `postMessage`, `KTX2DECODER`). It holds no
 *  `throw new Error("…")`: Lite's production error plugin would rewrite one into a call to an imported helper that
 *  does not exist in the worker realm, so failures are posted back as messages instead. */
export function _ktx2WorkerMain(): void {
    type DecoderModule = {
        KTX2Decoder: new () => { decode(data: Uint8Array, caps: unknown, options?: unknown): Promise<{ mipmaps: { data?: Uint8Array }[] }> };
        MSCTranscoder: { UseFromWorkerThread: boolean };
        WASMMemoryManager: { LoadBinariesFromCurrentThread: boolean };
    };
    const scope = self as unknown as {
        importScripts(url: string): void;
        postMessage(message: unknown, transfer?: Transferable[]): void;
        onmessage: ((event: MessageEvent) => void) | null;
        KTX2DECODER?: DecoderModule;
    };
    let decoder: InstanceType<DecoderModule["KTX2Decoder"]> | null = null;
    const errorText = (error: unknown): string => String((error as Error)?.message ?? error);
    // The buffers to transfer with a reply. A mip that is a view into a larger buffer (the transcoder's own memory,
    // or a sibling mip's) is copied first, so nothing the worker still uses is detached; `copyAll` copies every mip,
    // for a buffer that looked transferable but is not (a full view of non-detachable memory, e.g. a
    // WebAssembly.Memory buffer).
    const transferList = (mipmaps: { data?: Uint8Array }[], copyAll: boolean): ArrayBuffer[] => {
        const transfer: ArrayBuffer[] = [];
        for (const mip of mipmaps) {
            let data = mip.data;
            if (!data) {
                continue;
            }
            if (copyAll || !(data.buffer instanceof ArrayBuffer) || data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength || transfer.includes(data.buffer)) {
                data = mip.data = data.slice();
            }
            transfer.push(data.buffer as ArrayBuffer);
        }
        return transfer;
    };
    scope.onmessage = (event: MessageEvent): void => {
        const message = event.data as Ktx2WorkerRequest;
        if (message.t === 0) {
            try {
                scope.importScripts(message.url);
                const mod = scope.KTX2DECODER;
                if (!mod) {
                    scope.postMessage({ t: 0, e: "decoder global KTX2DECODER not found after importScripts" });
                    return;
                }
                mod.MSCTranscoder.UseFromWorkerThread = true;
                mod.WASMMemoryManager.LoadBinariesFromCurrentThread = true;
                const overrides = message.wasmUrls ?? {};
                const targets = mod as unknown as Record<string, Record<string, string> | undefined>;
                for (const name of Object.keys(overrides)) {
                    const target = targets[name];
                    if (target) {
                        for (const prop of Object.keys(overrides[name]!)) {
                            target[prop] = overrides[name]![prop]!;
                        }
                    }
                }
                decoder = new mod.KTX2Decoder();
                scope.postMessage({ t: 0 });
            } catch (error) {
                scope.postMessage({ t: 0, e: errorText(error) });
            }
            return;
        }
        const id = message.id;
        if (!decoder) {
            scope.postMessage({ t: 1, id, e: "decoder not initialised" });
            return;
        }
        // Every failure — the decode, preparing the reply or posting it — answers this job, so the caller never
        // waits forever. A reply whose transfer is refused (DataCloneError, before anything is detached) is sent
        // again with the worker's own copies.
        decoder
            .decode(message.data, message.caps, message.options)
            .then((decoded) => {
                try {
                    scope.postMessage({ t: 1, id, d: decoded }, transferList(decoded.mipmaps, false));
                } catch {
                    scope.postMessage({ t: 1, id, d: decoded }, transferList(decoded.mipmaps, true));
                }
            })
            .catch((error: unknown) => scope.postMessage({ t: 1, id, e: errorText(error) }));
    };
}

interface PoolWorker {
    worker: Worker;
    pending: number;
}

let _enabled = false;
let _pool: Promise<Ktx2Decoder> | null = null;

/** Resolve a possibly relative URL against the page, since a blob-URL worker has no usable base URL. */
function absoluteUrl(url: string): string {
    return typeof document === "undefined" ? url : new URL(url, document.baseURI).href;
}

function startWorker(source: string, init: Ktx2WorkerRequest, onReply: (reply: Ktx2WorkerReply) => void, onCrash: (worker: Worker, message: string) => void): Promise<Worker> {
    return new Promise<Worker>((resolve, reject) => {
        const worker = new Worker(source);
        worker.onerror = (event: ErrorEvent): void => reject(new Error(event.message || "KTX2 worker failed to start"));
        worker.onmessage = (event: MessageEvent<Ktx2WorkerReply>): void => {
            const reply = event.data;
            if (reply.t !== 0) {
                onReply(reply);
                return;
            }
            if (reply.e) {
                worker.terminate();
                reject(new Error(`KTX2 worker: ${reply.e}`));
                return;
            }
            worker.onmessage = (next: MessageEvent<Ktx2WorkerReply>): void => onReply(next.data);
            worker.onerror = (event: ErrorEvent): void => onCrash(worker, event.message || "KTX2 worker crashed");
            resolve(worker);
        };
        worker.postMessage(init);
    });
}

async function createPool(count: number): Promise<Ktx2Decoder> {
    const { url, wasmUrls } = _getKtx2DecoderUrls();
    const absoluteWasmUrls: Record<string, Record<string, string>> | null = wasmUrls ? {} : null;
    for (const name of Object.keys(wasmUrls ?? {})) {
        const entry: Record<string, string> = {};
        for (const prop of Object.keys(wasmUrls![name]!)) {
            entry[prop] = absoluteUrl(wasmUrls![name]![prop]!);
        }
        absoluteWasmUrls![name] = entry;
    }
    const init: Ktx2WorkerRequest = { t: 0, url: absoluteUrl(url), wasmUrls: absoluteWasmUrls };
    let workers: PoolWorker[] = [];
    // Liveness is decided as each worker acknowledges or crashes, never by re-reading the start-up results: a
    // worker that crashed while a sibling was still starting must not come back into the pool.
    const crashed = new Set<Worker>();
    const waiting = new Map<number, { resolve(decoded: Ktx2DecodedData): void; reject(error: Error): void; owner: PoolWorker }>();
    const onReply = (reply: Ktx2WorkerReply): void => {
        if (reply.t !== 1) {
            return;
        }
        const job = waiting.get(reply.id);
        if (!job) {
            return;
        }
        waiting.delete(reply.id);
        job.owner.pending--;
        if (reply.e || !reply.d) {
            job.reject(new Error(`KTX2: ${reply.e ?? "worker returned no data"}`));
        } else {
            job.resolve(reply.d);
        }
    };
    // A worker that dies after start-up fails its own in-flight jobs and leaves the pool; the others carry on.
    const onCrash = (worker: Worker, message: string): void => {
        crashed.add(worker);
        worker.terminate();
        workers = workers.filter((entry) => entry.worker !== worker);
        for (const [id, job] of waiting) {
            if (job.owner.worker === worker) {
                waiting.delete(id);
                job.reject(new Error(`KTX2: ${message}`));
            }
        }
    };
    const blobUrl = URL.createObjectURL(new Blob([`(${_ktx2WorkerMain.toString()})();`], { type: "text/javascript" }));
    try {
        const started = await Promise.allSettled(
            Array.from({ length: count }, () =>
                startWorker(blobUrl, init, onReply, onCrash).then((worker) => {
                    if (!crashed.has(worker)) {
                        workers.push({ worker, pending: 0 });
                    }
                    return worker;
                })
            )
        );
        if (!workers.length) {
            const failed = started.find((r): r is PromiseRejectedResult => r.status === "rejected");
            throw failed ? failed.reason : new Error("KTX2: every decoding worker crashed during start-up");
        }
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
    let nextId = 0;
    return {
        decode(data: Uint8Array, caps: Ktx2DecoderCaps, options?: { forceRGBA?: boolean }): Promise<Ktx2DecodedData> {
            // Least-busy worker; the caller keeps its bytes (a copy is transferred, not the caller's buffer).
            if (!workers.length) {
                return Promise.reject(new Error("KTX2: every decoding worker has crashed"));
            }
            let owner = workers[0]!;
            for (const candidate of workers) {
                if (candidate.pending < owner.pending) {
                    owner = candidate;
                }
            }
            const id = nextId++;
            const copy = data.slice();
            owner.pending++;
            return new Promise<Ktx2DecodedData>((resolve, reject) => {
                waiting.set(id, { resolve, reject, owner });
                const request: Ktx2WorkerRequest = { t: 1, id, data: copy, caps, ...(options ? { options } : {}) };
                owner.worker.postMessage(request, [copy.buffer]);
            });
        },
    };
}

/** Transcode KTX2/Basis textures in a pool of Web Workers instead of on the main thread. Call once, before or
 *  after `setKtx2DecoderUrl`, but before the first KTX2 texture loads; later calls are ignored. Falls back to the
 *  main-thread decoder when `Worker` is unavailable or no worker can initialise the decoder. */
export function enableKtx2WorkerDecoding(options: Ktx2WorkerDecodingOptions = {}): void {
    if (_enabled || typeof Worker === "undefined") {
        return;
    }
    _enabled = true;
    const hardware = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
    const count = Math.max(1, Math.floor(options.workerCount ?? Math.min(4, Math.max(1, hardware - 1))));
    _setKtx2DecoderSource(() => {
        _pool ??= createPool(count).catch((error: unknown) => {
            console.warn("KTX2: worker decoding unavailable, falling back to the main thread.", error);
            _setKtx2DecoderSource(null);
            return loadKtx2Decoder();
        });
        return _pool;
    });
}
