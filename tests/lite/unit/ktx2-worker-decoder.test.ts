import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInContext, runInNewContext } from "node:vm";
import { resolveObjectURL } from "node:buffer";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type * as Ktx2LoaderModule from "../../../packages/babylon-lite/src/texture/ktx2-loader";
import type * as WorkerDecoderModule from "../../../packages/babylon-lite/src/texture/ktx2-worker-decoder";

const CAPS = { astc: false, bptc: true, s3tc: true, pvrtc: false, etc2: false, etc1: false };

/** Allocators that build decoder output INSIDE the worker's VM realm, so the worker's own `instanceof ArrayBuffer`
 *  sees it as the real decoder's output and the direct-transfer branch is exercised. */
interface RealmTools {
    /** A fresh full-span Uint8Array of the worker realm. */
    u8(length: number): Uint8Array;
    /** A full-span Uint8Array over a WebAssembly.Memory buffer of the worker realm (not detachable). */
    wasmView(): Uint8Array;
}

interface FakeDecoderBehaviour {
    /** Throw from importScripts (decoder script unreachable). */
    failImport?: boolean;
    /** importScripts succeeds but defines no KTX2DECODER global. */
    noGlobal?: boolean;
    /** Make every decode reject with this message. */
    decodeError?: string;
    /** Called inside the worker with the bytes it received; returns the mips to report. */
    mips?: (input: Uint8Array, realm: RealmTools) => Uint8Array[];
    /** The worker's postMessage throws for any reply that carries decoded data. */
    replyThrows?: boolean;
    /** Delay delivering the init message to the worker with this index until the promise settles. */
    holdInit?: (index: number) => Promise<void> | undefined;
    /** Fail this worker through its real onerror handler before init is acknowledged. */
    failBeforeInit?: (index: number) => string | undefined;
}

interface WorkerRecord {
    importedUrls: string[];
    module: Record<string, Record<string, unknown>> | null;
    received: Uint8Array[];
    /** The init acknowledgement reached the pool. */
    acked: boolean;
    terminated: boolean;
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
        private readonly index: number;
        constructor(url: string) {
            const record: WorkerRecord = {
                importedUrls: [],
                module: null,
                received: [],
                acked: false,
                terminated: false,
                crash: (message) => this.onerror?.({ message }),
            };
            this.index = records.length;
            records.push(record);
            const blob = resolveObjectURL(url);
            if (!blob) {
                throw new Error(`no blob behind ${url}`);
            }
            this.ready = blob.text().then((source) => {
                const realm: Record<string, unknown> = {
                    postMessage: (message: { t?: number; d?: unknown }, transfer: Transferable[] = []) => {
                        if (behaviour.replyThrows && message.d) {
                            throw new Error("DataCloneError: reply refused");
                        }
                        const data = structuredClone(message, { transfer: transfer as Transferable[] });
                        queueMicrotask(() => {
                            if (this.terminated) {
                                return;
                            }
                            if (message.t === 0) {
                                record.acked = true;
                            }
                            this.onmessage?.({ data });
                        });
                    },
                    importScripts: (scriptUrl: string) => {
                        record.importedUrls.push(scriptUrl);
                        if (behaviour.failImport) {
                            throw new Error(`cannot load ${scriptUrl}`);
                        }
                        if (behaviour.noGlobal) {
                            return;
                        }
                        const tools: RealmTools = {
                            u8: (length) => runInContext(`new Uint8Array(${length})`, realm) as Uint8Array,
                            wasmView: () => runInContext("new Uint8Array(new WebAssembly.Memory({ initial: 1 }).buffer)", realm) as Uint8Array,
                        };
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
                                    const mips = behaviour.mips?.(data, tools) ?? [tools.u8(16).fill(7)];
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
        postMessage(message: { t?: number }, transfer: Transferable[] = []): void {
            const data = structuredClone(message, { transfer });
            const initError = message.t === 0 ? behaviour.failBeforeInit?.(this.index) : undefined;
            if (initError) {
                queueMicrotask(() => this.onerror?.({ message: initError }));
                return;
            }
            const hold = message.t === 0 ? behaviour.holdInit?.(this.index) : undefined;
            void Promise.all([this.ready, hold]).then(([deliver]) => !this.terminated && deliver(data));
        }
        terminate(): void {
            this.terminated = true;
            records[this.index]!.terminated = true;
        }
    }
    vi.stubGlobal("Worker", FakeWorker);
    return records;
}

async function freshModules(): Promise<{ loader: typeof Ktx2LoaderModule; workers: typeof WorkerDecoderModule }> {
    vi.resetModules();
    const loader = await import("../../../packages/babylon-lite/src/texture/ktx2-loader");
    const workers = await import("../../../packages/babylon-lite/src/texture/ktx2-worker-decoder");
    return { loader, workers };
}

/** Fail fast instead of hanging the suite when a job is never answered. */
function settlesWithin<T>(promise: Promise<T>, ms = 1000): Promise<T> {
    return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`job still waiting after ${ms} ms`)), ms))]);
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

    it("resolves decoder and transcoder URLs against an HTTPS worker caller when document is absent", async () => {
        vi.stubGlobal("document", undefined);
        vi.stubGlobal("location", { href: "https://game.example/workers/texture-worker.js" });
        const records = installFakeWorker({});
        const { loader, workers } = await freshModules();
        loader.setKtx2DecoderUrl("../assets/ktx2/babylon.ktx2Decoder.js", {
            MSCTranscoder: { JSModuleURL: "./msc.js", WasmModuleURL: "../wasm/msc.wasm" },
            ZSTDDecoder: { WasmModuleURL: "https://cdn.example/ktx2/zstd.wasm" },
        });
        workers.enableKtx2WorkerDecoding({ workerCount: 1 });

        await loader.loadKtx2Decoder();

        expect(records[0]!.importedUrls).toEqual(["https://game.example/assets/ktx2/babylon.ktx2Decoder.js"]);
        expect(records[0]!.module!.MSCTranscoder).toMatchObject({
            JSModuleURL: "https://game.example/workers/msc.js",
            WasmModuleURL: "https://game.example/wasm/msc.wasm",
        });
        expect(records[0]!.module!.ZSTDDecoder!.WasmModuleURL).toBe("https://cdn.example/ktx2/zstd.wasm");
    });

    it("transfers a decoder-owned full-span mip without copying it", async () => {
        const produced: Uint8Array[] = [];
        installFakeWorker({
            mips: (_input, realm) => {
                const mip = realm.u8(16).fill(5);
                produced.push(mip);
                return [mip];
            },
        });
        const { loader, workers } = await freshModules();
        workers.enableKtx2WorkerDecoding({ workerCount: 1 });
        const decoded = await (await loader.loadKtx2Decoder()).decode(new Uint8Array([1]), CAPS);
        expect([...decoded.mipmaps[0]!.data]).toEqual(new Array(16).fill(5));
        expect(produced[0]!.byteLength, "the worker's own mip was transferred, so it is detached there").toBe(0);
    });

    it("copies mips that share one buffer or view a larger one, and leaves the worker's memory attached", async () => {
        const arenas: Uint8Array[] = [];
        installFakeWorker({
            mips: (_input, realm) => {
                const arena = realm.u8(32);
                arena.set(new Array(16).fill(1), 0);
                arena.set(new Array(4).fill(2), 16);
                arenas.push(arena);
                const own = realm.u8(1).fill(3);
                return [arena.subarray(0, 16), arena.subarray(16, 20), own];
            },
        });
        const { loader, workers } = await freshModules();
        workers.enableKtx2WorkerDecoding({ workerCount: 1 });
        const decoded = await (await loader.loadKtx2Decoder()).decode(new Uint8Array([9]), CAPS);
        expect(decoded.mipmaps.map((m) => [...m.data])).toEqual([new Array(16).fill(1), new Array(4).fill(2), [3]]);
        expect(arenas[0]!.byteLength, "views are copied, never detaching the decoder's arena").toBe(32);
    });

    it("answers the job with copies when a mip views non-detachable WebAssembly memory", async () => {
        installFakeWorker({
            mips: (_input, realm) => {
                const view = realm.wasmView();
                view.fill(4, 0, 8);
                return [view];
            },
        });
        const { loader, workers } = await freshModules();
        workers.enableKtx2WorkerDecoding({ workerCount: 1 });
        const decoded = await settlesWithin((await loader.loadKtx2Decoder()).decode(new Uint8Array([1]), CAPS));
        expect(decoded.mipmaps[0]!.data.byteLength).toBe(65536);
        expect([...decoded.mipmaps[0]!.data.subarray(0, 9)]).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 0]);
    });

    it("rejects the job, never leaving it waiting, when the reply itself cannot be posted", async () => {
        installFakeWorker({ replyThrows: true });
        const { loader, workers } = await freshModules();
        workers.enableKtx2WorkerDecoding({ workerCount: 1 });
        const decoder = await loader.loadKtx2Decoder();
        await expect(settlesWithin(decoder.decode(new Uint8Array([1]), CAPS))).rejects.toThrow("KTX2: DataCloneError: reply refused");
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
        const records = installFakeWorker({ mips: (_input, realm) => [realm.u8(1).fill(hold ? 1 : 2)] });
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

    it("never sends a job to a worker that crashed while a sibling was still starting", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const records = installFakeWorker({ holdInit: (index) => (index === 1 ? gate : undefined) });
        const { loader, workers } = await freshModules();
        workers.enableKtx2WorkerDecoding({ workerCount: 2 });
        const pool = loader.loadKtx2Decoder();
        await vi.waitFor(() => expect(records[0]?.acked).toBe(true));
        records[0]!.crash("lost during start-up");
        release();
        const decoder = await pool;
        const decoded = await settlesWithin(decoder.decode(new Uint8Array([1]), CAPS));
        expect([...decoded.mipmaps[0]!.data]).toEqual(new Array(16).fill(7));
        expect(records.map((r) => r.received.length)).toEqual([0, 1]);
    });

    it("terminates and excludes a worker that errors before acknowledging initialization", async () => {
        const records = installFakeWorker({ failBeforeInit: (index) => (index === 0 ? "failed before init acknowledgment" : undefined) });
        const { loader, workers } = await freshModules();
        workers.enableKtx2WorkerDecoding({ workerCount: 2 });

        const decoder = await loader.loadKtx2Decoder();
        const decoded = await decoder.decode(new Uint8Array([1]), CAPS);

        expect(records[0]!.terminated, "the rejected pre-init worker must release its resources").toBe(true);
        expect(records[0]!.acked).toBe(false);
        expect(
            records.map((record) => record.received.length),
            "the rejected worker must not enter the live pool"
        ).toEqual([0, 1]);
        expect([...decoded.mipmaps[0]!.data]).toEqual(new Array(16).fill(7));
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

    it("reports a missing decoder global through the init reply and falls back", async () => {
        installFakeWorker({ noGlobal: true });
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
        workers.enableKtx2WorkerDecoding({ workerCount: 1 });
        expect(await loader.loadKtx2Decoder()).toBe(mainThreadDecoder);
        expect(String(warn.mock.calls[0]![1])).toContain("decoder global KTX2DECODER not found after importScripts");
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

describe("_ktx2WorkerMain under the production error plugin", () => {
    it("holds no `throw new Error(…)` the plugin would turn into a helper the worker realm lacks", () => {
        // scripts/lite-error-plugin.ts rewrites `throw new Error(<string | template>)` into an imported
        // ThrowLiteError call; the worker body is stringified on its own, so such a rewrite would leave it calling an
        // undefined helper. Any throw of `new Error(...)` inside the worker function is refused here.
        const file = new URL("../../../packages/babylon-lite/src/texture/ktx2-worker-decoder.ts", import.meta.url);
        const source = ts.createSourceFile("ktx2-worker-decoder.ts", readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
        let body: ts.Node | undefined;
        source.forEachChild((node) => {
            if (ts.isFunctionDeclaration(node) && node.name?.text === "_ktx2WorkerMain") {
                body = node.body;
            }
        });
        expect(body, "the worker function is found").toBeDefined();
        const throwsError: string[] = [];
        const visit = (node: ts.Node): void => {
            if (ts.isThrowStatement(node) && ts.isNewExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Error") {
                throwsError.push(node.getText(source));
            }
            ts.forEachChild(node, visit);
        };
        visit(body!);
        expect(throwsError).toEqual([]);
    });
});
