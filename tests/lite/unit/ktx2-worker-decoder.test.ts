import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { resolveObjectURL } from "node:buffer";

type Ktx2LoaderModule = typeof import("../../../packages/babylon-lite/src/texture/ktx2-loader");
type WorkerDecoderModule = typeof import("../../../packages/babylon-lite/src/texture/ktx2-worker-decoder");

const CAPS = { astc: false, bptc: true, s3tc: true, pvrtc: false, etc2: false, etc1: false };

interface FakeDecoderBehaviour {
    /** Throw from importScripts (decoder script unreachable). */
    failImport?: boolean;
    /** Make every decode reject with this message. */
    decodeError?: string;
    /** Called inside the worker with the bytes it received; returns the mips to report. */
    mips?: (input: Uint8Array) => Uint8Array[];
}

interface WorkerRecord {
    importedUrls: string[];
    module: Record<string, Record<string, unknown>> | null;
    received: Uint8Array[];
    crash(message: string): void;
}

/** A Worker stand-in that evaluates the real blob source in its own VM realm and bridges messages through
 *  structuredClone with the given transfer lists, so detaching and copying behave as in a browser. */
function installFakeWorker(behaviour: FakeDecoderBehaviour): WorkerRecord[] {
    const records: WorkerRecord[] = [];
    class FakeWorker {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onerror: ((event: { message: string }) => void) | null = null;
        private ready: Promise<(message: unknown) => void>;
        private terminated = false;
        constructor(url: string) {
            const record: WorkerRecord = {
                importedUrls: [],
                module: null,
                received: [],
                crash: (message) => this.onerror?.({ message }),
            };
            records.push(record);
            const blob = resolveObjectURL(url);
            if (!blob) {
                throw new Error(`no blob behind ${url}`);
            }
            this.ready = blob.text().then((source) => {
                const realm: Record<string, unknown> = {
                    postMessage: (message: unknown, transfer: Transferable[] = []) => {
                        const data = structuredClone(message, { transfer: transfer as Transferable[] });
                        queueMicrotask(() => !this.terminated && this.onmessage?.({ data }));
                    },
                    importScripts: (scriptUrl: string) => {
                        record.importedUrls.push(scriptUrl);
                        if (behaviour.failImport) {
                            throw new Error(`cannot load ${scriptUrl}`);
                        }
                        const module = {
                            MSCTranscoder: { UseFromWorkerThread: false, JSModuleURL: "", WasmModuleURL: "" },
                            WASMMemoryManager: { LoadBinariesFromCurrentThread: false },
                            ZSTDDecoder: { WasmModuleURL: "" },
                            KTX2Decoder: class {
                                decode(data: Uint8Array): Promise<unknown> {
                                    record.received.push(data);
                                    if (behaviour.decodeError) {
                                        return Promise.reject(new Error(behaviour.decodeError));
                                    }
                                    const mips = behaviour.mips?.(data) ?? [new Uint8Array(16).fill(7)];
                                    return Promise.resolve({
                                        width: 4,
                                        height: 4,
                                        transcodedFormat: 0x8e8c,
                                        isInGammaSpace: false,
                                        hasAlpha: false,
                                        transcoderName: "fake",
                                        mipmaps: mips.map((m, i) => ({ width: 4 >> i || 1, height: 4 >> i || 1, data: m })),
                                    });
                                }
                            },
                        };
                        record.module = module as unknown as Record<string, Record<string, unknown>>;
                        realm.KTX2DECODER = module;
                    },
                    onmessage: null,
                };
                realm.self = realm;
                runInNewContext(source, realm);
                return (message: unknown) => (realm.onmessage as (event: { data: unknown }) => void)({ data: message });
            });
        }
        postMessage(message: unknown, transfer: Transferable[] = []): void {
            const data = structuredClone(message, { transfer });
            void this.ready.then((deliver) => !this.terminated && deliver(data));
        }
        terminate(): void {
            this.terminated = true;
        }
    }
    vi.stubGlobal("Worker", FakeWorker);
    return records;
}

async function freshModules(): Promise<{ loader: Ktx2LoaderModule; workers: WorkerDecoderModule }> {
    vi.resetModules();
    const loader = await import("../../../packages/babylon-lite/src/texture/ktx2-loader");
    const workers = await import("../../../packages/babylon-lite/src/texture/ktx2-worker-decoder");
    return { loader, workers };
}

describe("enableKtx2WorkerDecoding", () => {
    beforeEach(() => {
        vi.stubGlobal("document", { baseURI: "https://game.example/app/index.html" });
        vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("decodes in a worker with absolute decoder and transcoder URLs, and leaves the caller's bytes intact", async () => {
        const records = installFakeWorker({});
        const { loader, workers } = await freshModules();
        loader.setKtx2DecoderUrl("/assets/ktx2/babylon.ktx2Decoder.js", {
            MSCTranscoder: { JSModuleURL: "/assets/ktx2/msc.js", WasmModuleURL: "msc.wasm" },
            ZSTDDecoder: { WasmModuleURL: "/assets/ktx2/zstd.wasm" },
        });
        workers.enableKtx2WorkerDecoding({ workerCount: 2 });

        const decoder = await loader.loadKtx2Decoder();
        const input = new Uint8Array([1, 2, 3, 4, 5]);
        const decoded = await decoder.decode(input, CAPS);

        expect(records).toHaveLength(2);
        expect(records[0]!.importedUrls).toEqual(["https://game.example/assets/ktx2/babylon.ktx2Decoder.js"]);
        expect(records[0]!.module!.MSCTranscoder).toMatchObject({
            UseFromWorkerThread: true,
            JSModuleURL: "https://game.example/assets/ktx2/msc.js",
            WasmModuleURL: "https://game.example/app/msc.wasm",
        });
        expect(records[0]!.module!.WASMMemoryManager!.LoadBinariesFromCurrentThread).toBe(true);
        expect(records[0]!.module!.ZSTDDecoder!.WasmModuleURL).toBe("https://game.example/assets/ktx2/zstd.wasm");
        expect(input.byteLength, "the caller's buffer must not be transferred away").toBe(5);
        expect([...records.flatMap((r) => r.received)[0]!]).toEqual([1, 2, 3, 4, 5]);
        expect(decoded.transcodedFormat).toBe(0x8e8c);
        expect([...decoded.mipmaps[0]!.data]).toEqual(new Array(16).fill(7));
    });

    it("returns every mip intact when mips share one buffer or are views into a larger one", async () => {
        installFakeWorker({
            mips: () => {
                const arena = new Uint8Array(32);
                arena.set(new Array(16).fill(1), 0);
                arena.set(new Array(4).fill(2), 16);
                return [arena.subarray(0, 16), arena.subarray(16, 20), new Uint8Array([3])];
            },
        });
        const { loader, workers } = await freshModules();
        workers.enableKtx2WorkerDecoding({ workerCount: 1 });
        const decoded = await (await loader.loadKtx2Decoder()).decode(new Uint8Array([9]), CAPS);
        expect(decoded.mipmaps.map((m) => [...m.data])).toEqual([new Array(16).fill(1), new Array(4).fill(2), [3]]);
    });

    it("spreads concurrent decodes over the least busy workers", async () => {
        const records = installFakeWorker({});
        const { loader, workers } = await freshModules();
        workers.enableKtx2WorkerDecoding({ workerCount: 3 });
        const decoder = await loader.loadKtx2Decoder();
        await Promise.all([1, 2, 3].map((n) => decoder.decode(new Uint8Array([n]), CAPS)));
        expect(records.map((r) => r.received.length)).toEqual([1, 1, 1]);
    });

    it("rejects a decode with the worker's error message", async () => {
        installFakeWorker({ decodeError: "corrupt supercompression" });
        const { loader, workers } = await freshModules();
        workers.enableKtx2WorkerDecoding({ workerCount: 1 });
        const decoder = await loader.loadKtx2Decoder();
        await expect(decoder.decode(new Uint8Array([1]), CAPS)).rejects.toThrow("KTX2: corrupt supercompression");
    });

    it("fails a crashed worker's in-flight job and keeps decoding on the others", async () => {
        let hold = true;
        const records = installFakeWorker({ mips: () => [new Uint8Array([hold ? 1 : 2])] });
        const { loader, workers } = await freshModules();
        workers.enableKtx2WorkerDecoding({ workerCount: 2 });
        const decoder = await loader.loadKtx2Decoder();
        // Freeze the first worker's reply by crashing it before its microtask delivers.
        const doomed = decoder.decode(new Uint8Array([1]), CAPS);
        records[0]!.crash("out of memory");
        await expect(doomed).rejects.toThrow("KTX2: out of memory");
        hold = false;
        const next = await decoder.decode(new Uint8Array([2]), CAPS);
        expect([...next.mipmaps[0]!.data]).toEqual([2]);
        expect(records[1]!.received).toHaveLength(1);
    });

    it("falls back to the main-thread decoder when no worker can load the decoder", async () => {
        installFakeWorker({ failImport: true });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const mainThreadDecoder = { decode: vi.fn() };
        vi.stubGlobal("KTX2DECODER", {
            KTX2Decoder: function () {
                return mainThreadDecoder;
            },
            MSCTranscoder: { UseFromWorkerThread: true },
            WASMMemoryManager: { LoadBinariesFromCurrentThread: false },
        });
        const { loader, workers } = await freshModules();
        workers.enableKtx2WorkerDecoding({ workerCount: 2 });
        const decoder = await loader.loadKtx2Decoder();
        expect(decoder).toBe(mainThreadDecoder);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(await loader.loadKtx2Decoder(), "later loads go straight to the main thread").toBe(mainThreadDecoder);
    });

    it("keeps the main-thread decoder when Worker does not exist", async () => {
        vi.stubGlobal("Worker", undefined);
        const mainThreadDecoder = { decode: vi.fn() };
        vi.stubGlobal("KTX2DECODER", {
            KTX2Decoder: function () {
                return mainThreadDecoder;
            },
            MSCTranscoder: { UseFromWorkerThread: true },
            WASMMemoryManager: { LoadBinariesFromCurrentThread: false },
        });
        const { loader, workers } = await freshModules();
        workers.enableKtx2WorkerDecoding();
        expect(await loader.loadKtx2Decoder()).toBe(mainThreadDecoder);
    });
});
