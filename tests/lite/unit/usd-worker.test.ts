import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractUsd, usdPath } from "../../../packages/babylon-lite/src/loader-usd/usd-worker-client";

interface Listener {
    (event: any): void;
}

class MockWorker {
    static instances: MockWorker[] = [];
    static complete = true;
    listeners = new Map<string, Listener[]>();
    terminate = vi.fn();
    posted: any;
    transfer: Transferable[] = [];

    constructor(
        public url: string | URL,
        public options?: WorkerOptions
    ) {
        MockWorker.instances.push(this);
    }
    addEventListener(type: string, callback: Listener): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(callback);
        this.listeners.set(type, listeners);
    }
    postMessage(message: any, transfer: Transferable[]): void {
        this.posted = message;
        this.transfer = transfer;
        if (!MockWorker.complete) {
            return;
        }
        queueMicrotask(() => {
            this.emit("message", { data: { type: "progress", requestId: 1, progress: { phase: "extracting", message: "Extracting" } } });
            this.emit("message", {
                data: {
                    type: "result",
                    requestId: 1,
                    commands: new ArrayBuffer(1),
                    data: new ArrayBuffer(2),
                    timings: { totalMs: 1, stageOpenMs: 1, stageReadMs: 0, preparationMs: 0, packingMs: 0, heapCopyMs: 0 },
                    statistics: { nodes: 0, meshes: 0, analyticPrimitives: 0, instances: 0, materials: 0, vertices: 0, triangles: 0, commandBytes: 1, dataBytes: 2 },
                    missingAssets: [],
                },
            });
        });
    }
    emit(type: string, event: any): void {
        this.listeners.get(type)?.forEach((listener) => listener(event));
    }
}

describe("USD worker transport", () => {
    beforeEach(() => {
        MockWorker.instances.length = 0;
        MockWorker.complete = true;
        vi.stubGlobal("Worker", MockWorker);
        vi.stubGlobal("location", new URL("https://app.example/viewer"));
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("copies source and sidecar bytes, preserves virtual paths and terminates its worker", async () => {
        const source = new Uint8Array([99, 0x50, 0x4b, 3, 4, 99]).subarray(1, 5);
        const layer = new Uint8Array([1, 2, 3]);
        const progress = vi.fn();
        const result = await extractUsd(source, {
            rootFileName: "Asset/Root",
            files: { "Asset/Layers/Part.usda": layer },
            onProgress: progress,
        });

        const worker = MockWorker.instances[0]!;
        expect(String(worker.url)).toMatch(/^blob:/);
        expect(worker.options).toEqual({ type: "module" });
        expect(worker.posted.asset.glueUrl).toBe("https://cdn.babylonjs.com/babylonUsdImporter/5/babylon-usd-importer.js");
        expect(worker.posted.asset.wasmUrl).toBe("https://cdn.babylonjs.com/babylonUsdImporter/5/babylon-usd-importer.wasm");
        expect(worker.posted.asset.fileName).toBe("Asset/Root.usdz");
        expect(Object.keys(worker.posted.asset.files)).toEqual(["Asset/Layers/Part.usda"]);
        expect(worker.posted.asset.bytes).not.toBe(source);
        expect(worker.posted.asset.files["Asset/Layers/Part.usda"]).not.toBe(layer);
        expect(source).toEqual(new Uint8Array([0x50, 0x4b, 3, 4]));
        expect(layer).toEqual(new Uint8Array([1, 2, 3]));
        expect(worker.transfer).toHaveLength(2);
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(progress.mock.calls.map(([value]) => value.phase)).toEqual(["fetching", "extracting"]);
        expect(result.data.byteLength).toBe(2);
    });

    it("fetches URL input, infers its filename and forwards native logs", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new Uint8Array([35, 117, 115, 100, 97]), { status: 200 }))
        );
        const log = vi.fn();
        const promise = extractUsd("https://assets.example/Robot.usda?version=1", { onLog: log });
        const worker = await vi.waitFor(() => expect(MockWorker.instances[0]).toBeDefined()).then(() => MockWorker.instances[0]!);
        worker.emit("message", { data: { type: "log", requestId: 1, level: 1, message: "notice" } });
        await promise;
        expect(worker.posted.asset.fileName).toBe("Robot.usda");
        expect(log).toHaveBeenCalledWith("warning", "notice");
    });

    it("rejects invalid paths and duplicate root entries before creating a worker", async () => {
        for (const path of ["", "/root.usda", "../root.usda", "C:\\root.usda", "https://example/root.usda", "a/\0/b.usda"]) {
            expect(() => usdPath(path)).toThrow("must be relative");
        }
        await expect(extractUsd(new ArrayBuffer(1), { rootFileName: "a/root.usda", files: { "a/root.usda": new ArrayBuffer(1) } })).rejects.toThrow("Duplicate USD virtual file");
        expect(MockWorker.instances).toHaveLength(0);
    });

    it("rejects promptly and terminates the worker when canceled", async () => {
        MockWorker.complete = false;
        const controller = new AbortController();
        const loading = extractUsd(new ArrayBuffer(1), { signal: controller.signal });
        await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
        controller.abort(new Error("Canceled by test"));
        await expect(loading).rejects.toThrow("Canceled by test");
        expect(MockWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    });

    it("uses a revocable module bootstrap for a cross-origin runtime", async () => {
        const create = vi.spyOn(URL, "createObjectURL");
        const revoke = vi.spyOn(URL, "revokeObjectURL");
        await extractUsd(new ArrayBuffer(1), { runtimeBaseUrl: "https://cdn.example/usd/" });
        expect(create).toHaveBeenCalledOnce();
        expect(MockWorker.instances[0]!.url).toBe(create.mock.results[0]!.value);
        expect(revoke).toHaveBeenCalledWith(create.mock.results[0]!.value);
    });
});
