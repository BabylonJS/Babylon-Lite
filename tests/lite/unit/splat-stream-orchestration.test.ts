import { describe, expect, it, vi } from "vitest";

import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { evictSplatSource } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-cache";
import {
    attachGaussianSplatStream,
    disposeGaussianSplatStream,
    forgetEvictedSplatStreamSource,
    loadGaussianSplatStream,
} from "../../../packages/babylon-lite/src/loader-splat-stream/load-gaussian-splat-stream";
import { SplatGpuBudgetPressureError, type PreparedSplatSource } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-requests";
import type { SplatStreamGpuState } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-gpu";
import type { StreamSource } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-types";

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function manifest(environment = false): unknown {
    return {
        version: 1,
        lodLevels: 2,
        lodErrors: true,
        filenames: ["broad/meta.json", "sparse/meta.json", "fine/meta.json"],
        environment: environment ? "environment/meta.json" : undefined,
        tree: {
            bound: { min: [-0.8, -0.4, -1], max: [0.8, 0.4, -0.1] },
            children: [
                {
                    bound: { min: [-0.8, -0.2, -0.8], max: [-0.2, 0.2, -0.1] },
                    lods: { "0": { file: 0, offset: 0, count: 1 }, "1": { file: 2, offset: 0, count: 2 } },
                    errors: [1, 0],
                },
                {
                    bound: { min: [0.2, -0.2, -0.8], max: [0.8, 0.2, -0.1] },
                    lods: { "0": { file: 1, offset: 0, count: 1 } },
                    errors: [1, 0],
                },
            ],
        },
    };
}

function prepared(source: StreamSource, generation: number, count = 4): PreparedSplatSource {
    const textures = Array.from({ length: 5 }, () => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })) as unknown as GPUTexture[];
    return {
        url: source.url,
        fileId: source.id,
        generation,
        width: 1,
        height: 1,
        count,
        textures,
        metadataBuffer: { destroy: vi.fn() } as unknown as GPUBuffer,
        meansMin: new Float32Array(3),
        meansMax: new Float32Array([1, 1, 1]),
        gpuBytes: 22,
        cpuBytes: 0,
    };
}

function harness(sourceManifest = manifest(false)) {
    const queueGate = deferred<void>();
    const calls: Array<{ source: StreamSource; generation: number; gate: ReturnType<typeof deferred<PreparedSplatSource>> }> = [];
    let update: ((context: { targetWidth: number; targetHeight: number; _camera?: Camera | null }) => void) | undefined;
    let draw: ((signal?: Promise<boolean> | null) => void) | undefined;
    const gpu = {
        capacity: 20,
        count: 0,
        intervals: [],
        contentGeneration: 0,
        gatheredGeneration: -1,
        disposed: false,
        canonical: { destroy: vi.fn() },
        gatherParams: { destroy: vi.fn() },
    } as unknown as SplatStreamGpuState;
    const engine = {
        _device: {
            queue: { onSubmittedWorkDone: vi.fn(() => queueGate.promise) },
        },
    } as unknown as EngineContext;
    (gpu as { engine: EngineContext }).engine = engine;
    const scene = {
        surface: { engine },
        _built: false,
        _beforeRender: [],
        _deferredBuilders: [],
        _renderables: [],
        _disposables: [],
        _renderableVersion: 0,
    } as unknown as SceneContext;
    const camera = {
        fov: Math.PI / 2,
        nearPlane: 0.1,
        farPlane: 100,
        children: [],
        worldMatrix: IDENTITY,
        worldMatrixVersion: 1,
        _viewCache: new Float32Array(16),
        _projCache: new Float32Array(16),
        _vpCache: new Float32Array(16),
    } as unknown as Camera;
    const fetch = vi.fn(async () => new Response(JSON.stringify(sourceManifest), { headers: { "content-type": "application/json" } }));
    const prepareSource = vi.fn((source: StreamSource, generation: number) => {
        const gate = deferred<PreparedSplatSource>();
        calls.push({ source, generation, gate });
        return gate.promise;
    });
    const buildRenderable = vi.fn(
        (_state: SplatStreamGpuState, _world: () => ArrayLike<number>, onUpdate: typeof update, onDraw: (signal: Promise<boolean> | null) => void): Renderable => {
            update = onUpdate;
            draw = (signal = Promise.resolve(true)) => onDraw(signal);
            return { order: 200, isTransparent: true, bind: vi.fn() } as unknown as Renderable;
        }
    );
    return { engine, scene, camera, gpu, queueGate, calls, fetch, prepareSource, buildRenderable, getUpdate: () => update!, getDraw: () => draw! };
}

async function attachAndBuild(h: ReturnType<typeof harness>, environment = false) {
    const stream = await loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
        maxSplats: 20,
        _runtime: {
            fetch: h.fetch,
            prepareSource: h.prepareSource,
            createGpuState: () => h.gpu,
            buildRenderable: h.buildRenderable,
            queueDone: () => h.queueGate.promise,
            now: () => 10,
        },
    });
    attachGaussianSplatStream(h.scene, stream);
    attachGaussianSplatStream(h.scene, stream);
    await h.scene._deferredBuilders[0]!();
    expect(h.calls[0]!.source.url).toBe("https://assets.test/broad/meta.json");
    h.calls[0]!.gate.resolve(prepared(h.calls[0]!.source, h.calls[0]!.generation));
    await vi.waitFor(() => expect(stream.stats.coveredLeaves).toBe(1));
    h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
    expect(h.calls).toHaveLength(1);
    h.getDraw()();
    await vi.waitFor(() => expect(h.calls.length).toBe(environment ? 4 : 3));
    return stream;
}

describe("Gaussian splat stream orchestration", () => {
    it("retries the initial manifest with configured transient backoff", async () => {
        const h = harness();
        let attempts = 0;
        const delays: number[] = [];
        h.fetch.mockImplementation(async () => {
            attempts++;
            return attempts < 3 ? new Response("", { status: 503 }) : new Response(JSON.stringify(manifest()), { headers: { "content-type": "application/json" } });
        });
        const stream = await loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
            maxSplats: 20,
            maxRetries: 2,
            _runtime: {
                fetch: h.fetch,
                delay: async (milliseconds) => {
                    delays.push(milliseconds);
                },
                prepareSource: h.prepareSource,
                createGpuState: () => h.gpu,
            },
        });
        expect(attempts).toBe(3);
        expect(delays).toHaveLength(2);
        const ready = stream.firstFrameReady.catch(() => undefined);
        disposeGaussianSplatStream(h.scene, stream);
        await ready;
    });

    it("draws the broad coarse source before sparse/refinement/environment work and fences firstFrameReady", async () => {
        const h = harness(manifest(true));
        const stream = await attachAndBuild(h, true);
        expect(h.calls.map((call) => call.source.url)).toEqual([
            "https://assets.test/broad/meta.json",
            "https://assets.test/sparse/meta.json",
            "https://assets.test/fine/meta.json",
            "https://assets.test/environment/meta.json",
        ]);
        expect(stream.stats.phase).toBe("streaming");
        let ready = false;
        void stream.firstFrameReady.then(() => {
            ready = true;
        });
        await Promise.resolve();
        expect(ready).toBe(false);
        h.queueGate.resolve();
        await stream.firstFrameReady;
        expect(ready).toBe(true);
        expect(stream.stats.firstFrameMs).toBe(0);
    });

    it("preserves one delayed environment request across repeated selection updates", async () => {
        const h = harness(manifest(true));
        const stream = await attachAndBuild(h, true);
        const environmentCalls = () => h.calls.filter((call) => call.source.url.endsWith("/environment/meta.json"));
        const environment = environmentCalls()[0]!;
        const environmentState = stream._sourceStates[environment.source.id]!;

        for (let frame = 0; frame < 4; frame++) {
            h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
            expect(environmentCalls()).toHaveLength(1);
            expect(environmentState.state).toBe("queued");
            expect(environmentState.request).not.toBeNull();
            expect(environmentState.demandCount).toBe(1);
            expect(environmentState.generation).toBe(environment.generation);
        }

        environment.gate.resolve(prepared(environment.source, environment.generation, 3));
        await vi.waitFor(() => expect(environmentState.state).toBe("resident"));
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(environmentCalls()).toHaveLength(1);
        expect(environmentState.gpu).not.toBeNull();
        expect(environmentState.demandCount).toBe(1);
        expect(stream._cache.entries.get(environment.source.url)!.activeRefs).toBeGreaterThan(0);
    });

    it("defers valid refinement under GPU pressure without losing fallback display or retrying every frame", async () => {
        const h = harness();
        const stream = await attachAndBuild(h);
        const fineCalls = () => h.calls.filter((call) => call.source.url.includes("/fine/"));
        const firstFine = fineCalls()[0]!;
        const fineState = stream._sourceStates[firstFine.source.id]!;
        expect(stream._gpu.ledger.tryReserve(1)).toBe(true);
        firstFine.gate.reject(new SplatGpuBudgetPressureError(firstFine.source.url, 22));
        await vi.waitFor(() => expect(fineState.state).toBe("blocked"));

        expect(stream.stats.phase).toBe("budget-limited");
        expect(stream.stats.error).toBeNull();
        expect(stream._leafStates[0]!.displayed).not.toBeNull();
        for (let frame = 0; frame < 4; frame++) {
            h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        }
        expect(fineCalls()).toHaveLength(1);

        expect(stream._gpu.ledger.tryReserve(1)).toBe(true);
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(fineCalls()).toHaveLength(1);
        stream._gpu.ledger.release(2);
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(fineCalls()).toHaveLength(2);
        const retry = fineCalls()[1]!;
        retry.gate.resolve(prepared(retry.source, retry.generation));
        await vi.waitFor(() => expect(fineState.state).toBe("resident"));
        expect(stream.stats.error).toBeNull();
        expect(stream._leafStates[0]!.displayed?.fileId).toBe(fineState.source.id);
    });

    it("retries still-demanded pressure only when a visibility change makes a warm source reclaimable", async () => {
        const h = harness();
        const stream = await attachAndBuild(h);
        const sparse = h.calls.find((call) => call.source.url.includes("/sparse/"))!;
        const fineCalls = () => h.calls.filter((call) => call.source.url.includes("/fine/"));
        sparse.gate.resolve(prepared(sparse.source, sparse.generation));
        await vi.waitFor(() => expect(stream.stats.coveredLeaves).toBe(2));
        const filler = stream._gpu.ledger.maxBytes - stream._gpu.ledger.allocatedBytes - 10;
        expect(stream._gpu.ledger.tryReserve(filler)).toBe(true);

        const firstFine = fineCalls()[0]!;
        firstFine.gate.reject(new SplatGpuBudgetPressureError(firstFine.source.url, 22));
        await vi.waitFor(() => expect(stream._sourceStates[firstFine.source.id]!.state).toBe("blocked"));
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(fineCalls()).toHaveLength(1);

        h.camera.fov = 0.25;
        const mutableCamera = h.camera as Camera & { worldMatrix: Float32Array; worldMatrixVersion: number };
        mutableCamera.worldMatrix[12] = -0.5;
        mutableCamera.worldMatrixVersion++;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream._cache.entries.get(sparse.source.url)!.activeRefs).toBe(0);
        expect(fineCalls()).toHaveLength(2);

        stream._gpu.ledger.release(filler);
        const retry = fineCalls()[1]!;
        retry.gate.resolve(prepared(retry.source, retry.generation));
        await vi.waitFor(() => expect(stream._leafStates[0]!.displayed?.fileId).toBe(retry.source.id));
        expect(stream.stats.error).toBeNull();
        expect(h.gpu.count).toBe(2);
    });

    it("does not verify or fail bootstrap while the coarse source is still loading", async () => {
        const h = harness(manifest(true));
        const stream = await loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
            maxSplats: 20,
            _runtime: {
                fetch: h.fetch,
                prepareSource: h.prepareSource,
                createGpuState: () => h.gpu,
                buildRenderable: h.buildRenderable,
                queueDone: () => h.queueGate.promise,
            },
        });
        attachGaussianSplatStream(h.scene, stream);
        await h.scene._deferredBuilders[0]!();

        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        h.getDraw()(null);
        await Promise.resolve();
        await Promise.resolve();

        expect(stream.stats.phase).toBe("bootstrap");
        expect(stream.stats.error).toBeNull();
        expect(stream._coarseSubmitted).toBe(false);
        expect(stream._refinementEnabled).toBe(false);
        expect(h.calls).toHaveLength(1);

        h.calls[0]!.gate.resolve(prepared(h.calls[0]!.source, h.calls[0]!.generation));
        await vi.waitFor(() => expect(stream.stats.coveredLeaves).toBe(1));
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        h.getDraw()(Promise.resolve(true));
        await vi.waitFor(() => expect(stream._refinementEnabled).toBe(true));
        expect(stream.stats.error).toBeNull();

        h.queueGate.resolve();
        await stream.firstFrameReady;
    });

    it("rejects readiness when the bootstrap indirect draw is GPU-empty", async () => {
        const h = harness();
        const stream = await loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
            maxSplats: 20,
            _runtime: {
                fetch: h.fetch,
                prepareSource: h.prepareSource,
                createGpuState: () => h.gpu,
                buildRenderable: h.buildRenderable,
                queueDone: () => h.queueGate.promise,
            },
        });
        attachGaussianSplatStream(h.scene, stream);
        await h.scene._deferredBuilders[0]!();
        h.calls[0]!.gate.resolve(prepared(h.calls[0]!.source, h.calls[0]!.generation));
        await vi.waitFor(() => expect(stream.stats.coveredLeaves).toBe(1));
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        h.getDraw()(Promise.resolve(false));
        await expect(stream.firstFrameReady).rejects.toThrow("no drawable splats");
        expect(stream.stats.phase).toBe("error");
    });

    it("keeps sparse/coarse fallbacks while replacements are delayed, cancelled, stale, or failed", async () => {
        const h = harness();
        const stream = await attachAndBuild(h);
        const sparse = h.calls.find((call) => call.source.url.includes("sparse"))!;
        const fine = h.calls.find((call) => call.source.url.includes("fine"))!;

        sparse.gate.resolve(prepared(sparse.source, sparse.generation));
        await vi.waitFor(() => expect(stream.stats.coveredLeaves).toBe(2));
        expect(stream._leafStates.map((state) => state.displayed?.lod)).toEqual([0, 0]);

        stream.screenError = 1000;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        fine.gate.resolve(prepared(fine.source, fine.generation));
        await Promise.resolve();
        await Promise.resolve();
        expect(stream._leafStates[0]!.displayed?.lod).toBe(0);
        expect(stream.stats.coveredLeaves).toBe(2);

        stream.screenError = 0.01;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        const replacement = h.calls.filter((call) => call.source.url.includes("fine")).at(-1)!;
        replacement.gate.reject(new Error("decode failed"));
        await vi.waitFor(() => expect(stream.stats.error?.message).toContain("decode failed"));
        expect(stream._leafStates[0]!.displayed?.lod).toBe(0);
    });

    it("removes historical leaves from the active generation as the camera changes region", async () => {
        const h = harness();
        const stream = await attachAndBuild(h);
        const sparse = h.calls.find((call) => call.source.url.includes("sparse"))!;
        const fine = h.calls.find((call) => call.source.url.includes("fine"))!;
        sparse.gate.resolve(prepared(sparse.source, sparse.generation));
        fine.gate.resolve(prepared(fine.source, fine.generation));
        await vi.waitFor(() => expect(stream.stats.coveredLeaves).toBe(2));

        h.camera.fov = 0.25;
        const mutableCamera = h.camera as Camera & { worldMatrix: Float32Array; worldMatrixVersion: number };
        mutableCamera.worldMatrix[12] = -0.5;
        mutableCamera.worldMatrixVersion++;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream.stats.visibleLeaves).toBe(1);
        expect(h.gpu.count).toBe(2);
        expect(stream._leafStates[1]!.displayed).not.toBeNull();
        expect(stream._cache.entries.get(sparse.source.url)!.displayedRefs).toBe(0);

        mutableCamera.worldMatrix[12] = 0.5;
        mutableCamera.worldMatrixVersion++;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream.stats.visibleLeaves).toBe(1);
        expect(h.gpu.count).toBe(1);
        expect(stream._leafStates[0]!.displayed).not.toBeNull();
        expect(stream._cache.entries.get(fine.source.url)!.displayedRefs).toBe(0);
        const fineLastUsed = stream._cache.entries.get(fine.source.url)!.lastUsedFrame;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream._cache.entries.get(fine.source.url)!.lastUsedFrame).toBe(fineLastUsed);

        forgetEvictedSplatStreamSource(stream, fine.source.url);
        expect(evictSplatSource(stream._cache, fine.source.url)).toBe(true);
        expect(stream._leafStates[0]!.displayed).toBeNull();
        mutableCamera.worldMatrix[12] = -0.5;
        mutableCamera.worldMatrixVersion++;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream._leafStates[0]!.visible).toBe(true);
        expect(stream._leafStates[0]!.displayed?.fileId).toBe(stream._bootstrapSourceId);
        const retry = h.calls.filter((call) => call.source.url.includes("/fine/"))[1]!;
        retry.gate.resolve(prepared(retry.source, retry.generation));
        await vi.waitFor(() => expect(stream._leafStates[0]!.displayed?.fileId).toBe(retry.source.id));
        expect(h.gpu.count).toBe(2);
    });

    it("rejects readiness and retires pending/resident work on idempotent disposal", async () => {
        const h = harness();
        const stream = await loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
            maxSplats: 20,
            _runtime: {
                fetch: h.fetch,
                prepareSource: h.prepareSource,
                createGpuState: () => h.gpu,
                buildRenderable: h.buildRenderable,
                queueDone: () => h.queueGate.promise,
            },
        });
        attachGaussianSplatStream(h.scene, stream);
        const ready = stream.firstFrameReady.catch((reason: unknown) => reason);
        disposeGaussianSplatStream(h.scene, stream);
        disposeGaussianSplatStream(h.scene, stream);
        expect(await ready).toMatchObject({ name: "AbortError" });
        expect(stream.stats.phase).toBe("disposed");

        const bootstrap = h.calls[0]!;
        const stale = prepared(bootstrap.source, bootstrap.generation);
        bootstrap.gate.resolve(stale);
        await Promise.resolve();
        await Promise.resolve();
        expect(stale.textures.every((texture) => vi.mocked(texture.destroy).mock.calls.length === 1)).toBe(true);
        expect(vi.mocked(h.gpu.canonical.destroy).mock.calls).toHaveLength(0);
    });
});
