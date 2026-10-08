import { describe, expect, it, vi } from "vitest";

import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { disposeScene } from "../../../packages/babylon-lite/src/scene/scene-core";
import { admitSplatSource, evictSplatSource, reserveSplatSourceGpuBytes } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-cache";
import {
    attachGaussianSplatStream,
    commitSplatStreamPendingRepresentations,
    disposeGaussianSplatStream,
    forgetEvictedSplatStreamSource,
    loadGaussianSplatStream,
} from "../../../packages/babylon-lite/src/loader-splat-stream/load-gaussian-splat-stream";
import {
    SplatGpuBudgetPressureError,
    SplatRequestPriority,
    type PreparedSplatSource,
    type SplatSourceRequest,
    type SplatStreamRequestManager,
} from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-requests";
import type { SplatStreamGpuState, SplatStreamSourceGpu } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-gpu";
import { createSplatStreamSelectionUpdate } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-material";
import type { GaussianSplatStream, StreamLeafRuntime, StreamRepresentation, StreamSource } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-types";

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

function twoCoolingLeavesManifest(): unknown {
    return {
        version: 1,
        lodLevels: 2,
        lodErrors: true,
        filenames: ["broad/meta.json", "sparse/meta.json", "fine/meta.json"],
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
                    lods: { "0": { file: 1, offset: 0, count: 1 }, "1": { file: 2, offset: 2, count: 2 } },
                    errors: [1, 0],
                },
            ],
        },
    };
}

function sharedSourceLodsManifest(): unknown {
    return {
        version: 1,
        lodLevels: 2,
        lodErrors: true,
        filenames: ["shared/meta.json"],
        tree: {
            bound: { min: [-0.4, -0.4, -0.8], max: [0.4, 0.4, -0.1] },
            lods: {
                "0": { file: 0, offset: 0, count: 1 },
                "1": { file: 0, offset: 1, count: 2 },
            },
            errors: [1, 0],
        },
    };
}

function sharedEnvironmentSourceManifest(): unknown {
    return {
        ...(sharedSourceLodsManifest() as object),
        environment: "shared/meta.json",
    };
}

function promotionManifest(): unknown {
    return {
        version: 1,
        lodLevels: 2,
        lodErrors: true,
        filenames: ["broad/meta.json", "shared/meta.json"],
        tree: {
            bound: { min: [-0.8, -0.2, -0.8], max: [0.8, 0.2, -0.1] },
            children: [
                {
                    bound: { min: [-0.8, -0.2, -0.8], max: [-0.2, 0.2, -0.1] },
                    lods: { "0": { file: 0, offset: 0, count: 1 }, "1": { file: 1, offset: 0, count: 2 } },
                    errors: [1, 0],
                },
                {
                    bound: { min: [0.2, -0.2, -0.8], max: [0.8, 0.2, -0.1] },
                    lods: { "0": { file: 1, offset: 2, count: 1 } },
                    errors: [0, 0],
                },
            ],
        },
    };
}

function offscreenBootstrapManifest(): unknown {
    return {
        version: 1,
        lodLevels: 1,
        lodErrors: true,
        filenames: ["broad/meta.json", "visible/meta.json"],
        tree: {
            bound: { min: [-4, -0.2, -0.8], max: [0.2, 0.2, -0.1] },
            children: [
                { bound: { min: [-4, -0.2, -0.8], max: [-3, 0.2, -0.1] }, lods: { "0": { file: 0, offset: 0, count: 1 } }, errors: [0] },
                { bound: { min: [-3, -0.2, -0.8], max: [-2, 0.2, -0.1] }, lods: { "0": { file: 0, offset: 1, count: 1 } }, errors: [0] },
                { bound: { min: [-0.2, -0.2, -0.8], max: [0.2, 0.2, -0.1] }, lods: { "0": { file: 1, offset: 0, count: 1 } }, errors: [0] },
            ],
        },
    };
}

function uncoveredFineManifest(): unknown {
    return {
        version: 1,
        lodLevels: 2,
        lodErrors: true,
        filenames: ["broad/meta.json", "coarse/meta.json", "first-fine/meta.json", "uncovered-fine/meta.json"],
        tree: {
            bound: { min: [-0.8, -0.2, -0.8], max: [0.8, 0.2, -0.1] },
            children: [
                {
                    bound: { min: [-0.8, -0.2, -0.8], max: [-0.2, 0.2, -0.1] },
                    lods: { "0": { file: 0, offset: 0, count: 1 }, "1": { file: 2, offset: 0, count: 2 } },
                    errors: [1, 0],
                },
                {
                    bound: { min: [0.2, -0.2, -0.8], max: [0.8, 0.2, -0.1] },
                    lods: { "0": { file: 1, offset: 0, count: 1 }, "1": { file: 3, offset: 0, count: 2 } },
                    errors: [1, 0],
                },
            ],
        },
    };
}

function residentFineFallbackManifest(environment = false): unknown {
    return {
        version: 1,
        lodLevels: 3,
        lodErrors: true,
        filenames: ["a-coarse/meta.json", "a-fine/meta.json", "b-coarse/meta.json", "b-mid/meta.json", "b-fine/meta.json"],
        environment: environment ? "environment/meta.json" : undefined,
        tree: {
            bound: { min: [-0.8, -0.2, -0.8], max: [0.8, 0.2, -0.1] },
            children: [
                {
                    bound: { min: [-0.8, -0.2, -0.8], max: [-0.2, 0.2, -0.1] },
                    lods: { "0": { file: 0, offset: 0, count: 20 }, "2": { file: 1, offset: 0, count: 70 } },
                    errors: [2, 1, 0],
                },
                {
                    bound: { min: [0.2, -0.2, -0.8], max: [0.8, 0.2, -0.1] },
                    lods: { "0": { file: 2, offset: 0, count: 5 }, "1": { file: 3, offset: 0, count: 20 }, "2": { file: 4, offset: 0, count: 30 } },
                    errors: [2, 1, 0],
                },
            ],
        },
    };
}

function combinedReductionManifest(): unknown {
    const counts = [
        [25, 30],
        [25, 30],
        [15, 16],
        [15, 16],
    ];
    return {
        version: 1,
        lodLevels: 2,
        lodErrors: true,
        filenames: ["coarse/meta.json", "fine/meta.json"],
        environment: "environment/meta.json",
        tree: {
            bound: { min: [-0.8, -0.4, -0.8], max: [0.8, 0.4, -0.1] },
            children: counts.map(([coarse, fine], index) => ({
                bound: { min: [-0.2, -0.2, -0.8], max: [0.2, 0.2, -0.1] },
                lods: {
                    "0": { file: 0, offset: counts.slice(0, index).reduce((sum, value) => sum + value[0]!, 0), count: coarse },
                    "1": { file: 1, offset: counts.slice(0, index).reduce((sum, value) => sum + value[1]!, 0), count: fine },
                },
                errors: [1, 0],
            })),
        },
    };
}

function multiCameraCapacityManifest(): unknown {
    return {
        version: 1,
        lodLevels: 2,
        lodErrors: true,
        filenames: ["a-coarse/meta.json", "a-fine/meta.json", "b-coarse/meta.json", "b-fine/meta.json"],
        tree: {
            bound: { min: [-0.8, -0.2, -0.8], max: [0.8, 0.2, -0.1] },
            children: [
                {
                    bound: { min: [-0.8, -0.2, -0.8], max: [-0.2, 0.2, -0.1] },
                    lods: { "0": { file: 0, offset: 0, count: 20 }, "1": { file: 1, offset: 0, count: 70 } },
                    errors: [1, 0],
                },
                {
                    bound: { min: [0.2, -0.2, -0.8], max: [0.8, 0.2, -0.1] },
                    lods: { "0": { file: 2, offset: 0, count: 40 }, "1": { file: 3, offset: 0, count: 70 } },
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

function injectResidentSource(stream: GaussianSplatStream, sourceId: number, count: number): SplatStreamSourceGpu {
    const state = stream._sourceStates[sourceId]!;
    const generation = ++state.generation;
    const source = prepared(state.source, generation, count);
    const textures = source.textures as [GPUTexture, GPUTexture, GPUTexture, GPUTexture, GPUTexture];
    const gpu: SplatStreamSourceGpu = {
        textures,
        views: textures.map((texture) => texture.createView()) as [GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView],
        codebooks: source.metadataBuffer,
        width: source.width,
        height: source.height,
        count: source.count,
        meansMin: source.meansMin,
        meansMax: source.meansMax,
        _destroyed: false,
    };
    expect(
        admitSplatSource(stream._cache, {
            url: state.source.url,
            generation,
            width: source.width,
            height: source.height,
            count: source.count,
            gpuBytes: source.gpuBytes,
            cpuBytes: source.cpuBytes,
            resources: { textures, metadataBuffer: source.metadataBuffer },
            pinCount: 0,
            displayedRefs: 0,
            pendingRefs: 0,
            activeRefs: 0,
            lastUsedFrame: stream._frame,
        })
    ).toBe(true);
    state.gpu = gpu;
    state.state = "resident";
    return gpu;
}

function representation(leafId: number, lod: number, count: number): StreamRepresentation {
    return { leafId, lod, fileId: lod, offset: 0, count, error: lod };
}

function harness(sourceManifest = manifest(false), capacity = 20) {
    let clock = 10;
    const queueGate = deferred<void>();
    const calls: Array<{ source: StreamSource; generation: number; gate: ReturnType<typeof deferred<PreparedSplatSource>> }> = [];
    let update: ((context: { targetWidth: number; targetHeight: number; _camera?: Camera | null }, binding?: object) => void) | undefined;
    let draw: ((signal?: Promise<boolean> | null) => void) | undefined;
    const gpu = {
        capacity,
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
    return {
        engine,
        scene,
        camera,
        gpu,
        queueGate,
        calls,
        fetch,
        prepareSource,
        buildRenderable,
        now: () => clock,
        setNow: (value: number) => {
            clock = value;
        },
        getUpdate: () => update!,
        getDraw: () => draw!,
    };
}

async function attachAndBuild(h: ReturnType<typeof harness>, environment = false, lodCooldownMs = 0) {
    const stream = await loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
        maxSplats: 20,
        lodCooldownMs,
        _runtime: {
            fetch: h.fetch,
            prepareSource: h.prepareSource,
            createGpuState: () => h.gpu,
            buildRenderable: h.buildRenderable,
            queueDone: () => h.queueGate.promise,
            now: h.now,
        },
    });
    void stream.firstFrameReady.catch(() => undefined);
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
    it.each([-2, 2])("evicts the farther off-screen source using the current camera at x=%s", async (x) => {
        const h = harness();
        const mutableCamera = h.camera as unknown as { worldMatrix: Float32Array; worldMatrixVersion: number };
        mutableCamera.worldMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const stream = await attachAndBuild(h);
        for (const call of h.calls.slice(1)) {
            call.gate.resolve(prepared(call.source, call.generation));
        }
        await vi.waitFor(() => expect(stream.stats.residentFiles).toBe(3));
        mutableCamera.worldMatrix[12] = x;
        mutableCamera.worldMatrixVersion++;
        h.camera.fov = 0.25;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream.stats.visibleLeaves).toBe(0);
        const farId = x > 0 ? 2 : 1;
        const nearId = x > 0 ? 1 : 2;
        const far = stream._sourceStates[farId]!;
        const near = stream._sourceStates[nearId]!;
        stream._cache.entries.get(near.source.url)!.lastUsedFrame = 0;
        stream._cache.entries.get(far.source.url)!.lastUsedFrame = 100;
        const ledger = stream._gpu.ledger;
        expect(ledger.tryReserve(ledger.maxBytes - ledger.allocatedBytes - ledger.heldBytes)).toBe(true);
        const evicted: string[] = [];
        expect(
            reserveSplatSourceGpuBytes(stream._cache, 22, (source) => {
                evicted.push(source.url);
                forgetEvictedSplatStreamSource(stream, source.url);
            })
        ).toBe(false);
        expect(evicted).toEqual([far.source.url]);
        expect(far.state).toBe("unrequested");
        expect(near.state).toBe("resident");
        expect(stream._cache.entries.has(stream._sourceStates[stream._bootstrapSourceId]!.source.url)).toBe(true);
        disposeGaussianSplatStream(h.scene, stream);
    });

    it("measures shared off-screen bounds in world space against every active camera and expires old views", async () => {
        const h = harness(twoCoolingLeavesManifest());
        const mutableCamera = h.camera as unknown as { worldMatrix: Float32Array; worldMatrixVersion: number };
        mutableCamera.worldMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const stream = await attachAndBuild(h);
        stream.position.x = 10;
        stream.scaling.set(2, 1, -1);
        h.scene._beforeRender[0]!(16);
        h.scene._beforeRender[0]!(16);
        const firstBinding = {};
        const secondBinding = {};
        const update = (x: number, binding: object): void => {
            mutableCamera.worldMatrix[12] = x;
            mutableCamera.worldMatrixVersion++;
            h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera }, binding);
        };
        const shared = stream._sourceStates[2]!.source.url;
        const broad = stream._sourceStates[0]!.source.url;
        const distance = stream._cache.getDistanceToCamera!;
        update(12, firstBinding);
        expect(stream.stats.visibleLeaves).toBe(0);
        expect(distance(shared)).toBeCloseTo(Math.hypot(0.4, 0.1), 5);
        expect(distance(broad)).toBeCloseTo(Math.hypot(2.4, 0.1), 5);
        update(9, secondBinding);
        expect(distance(shared)).toBeCloseTo(0.1, 5);
        update(12, firstBinding);
        expect(distance(shared)).toBeCloseTo(0.1, 5);
        for (let frame = 0; frame < 2; frame++) {
            h.scene._beforeRender[0]!(16);
            update(12, firstBinding);
        }
        expect(distance(shared)).toBeCloseTo(Math.hypot(0.4, 0.1), 5);
        stream.position.x = 9;
        expect(distance(shared)).toBeCloseTo(Math.hypot(1.4, 0.1), 5);
        disposeGaussianSplatStream(h.scene, stream);
    });

    it("keeps shared-source fine data behind the coarse draw barrier and starts cooldown only after refinement publishes", async () => {
        const h = harness(sharedSourceLodsManifest());
        h.setNow(10);
        const stream = await loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
            maxSplats: 20,
            screenError: 0.001,
            lodCooldownMs: 250,
            _runtime: {
                fetch: h.fetch,
                prepareSource: h.prepareSource,
                createGpuState: () => h.gpu,
                buildRenderable: h.buildRenderable,
                queueDone: () => h.queueGate.promise,
                now: h.now,
            },
        });
        attachGaussianSplatStream(h.scene, stream);
        await h.scene._deferredBuilders[0]!();
        h.calls[0]!.gate.resolve(prepared(h.calls[0]!.source, h.calls[0]!.generation));
        await vi.waitFor(() => expect(stream._leafStates[0]!.displayed?.count).toBe(1));

        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream._leafStates[0]!.target.count).toBe(2);
        expect(stream._leafStates[0]!.displayed?.count).toBe(1);
        expect(stream._leafStates[0]!.lodCooldownUntil).toBe(0);
        expect(stream._generationPressure).toBe(false);

        h.setNow(20);
        h.getDraw()(Promise.resolve(true));
        await vi.waitFor(() => expect(stream._refinementEnabled).toBe(true));
        expect(stream._leafStates[0]!.displayed?.count).toBe(2);
        expect(stream._leafStates[0]!.lodCooldownUntil).toBe(270);
        expect(stream._generationPressure).toBe(false);
    });

    it("shares an aliased bootstrap environment source without publishing it before the coarse barrier", async () => {
        const h = harness(sharedEnvironmentSourceManifest(), 20);
        const stream = await loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
            maxSplats: 20,
            screenError: 0.001,
            _runtime: {
                fetch: h.fetch,
                prepareSource: h.prepareSource,
                createGpuState: () => h.gpu,
                buildRenderable: h.buildRenderable,
                queueDone: () => h.queueGate.promise,
            },
        });
        void stream.firstFrameReady.catch(() => undefined);
        attachGaussianSplatStream(h.scene, stream);
        await h.scene._deferredBuilders[0]!();
        expect(stream._environmentSourceId).toBe(stream._bootstrapSourceId);
        h.calls[0]!.gate.resolve(prepared(h.calls[0]!.source, h.calls[0]!.generation, 4));
        await vi.waitFor(() => expect(stream._leafStates[0]!.displayed?.count).toBe(1));
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(h.calls).toHaveLength(1);
        expect(h.gpu.intervals).toHaveLength(1);
        expect(h.gpu.intervals[0]).toMatchObject({ sourceOffset: 0, count: 1, destinationOffset: 0 });

        h.getDraw()(Promise.resolve(true));
        await vi.waitFor(() => expect(stream._refinementEnabled).toBe(true));
        expect(h.calls).toHaveLength(1);
        expect(h.gpu.intervals).toHaveLength(2);
        expect(h.gpu.intervals[0]).toMatchObject({ sourceOffset: 1, count: 2, destinationOffset: 0 });
        expect(h.gpu.intervals[1]).toMatchObject({ sourceOffset: 0, count: 4, destinationOffset: 2 });
        expect(stream._cache.entries.size).toBe(1);
        expect(stream._cache.entries.get(h.calls[0]!.source.url)).toMatchObject({ displayedRefs: 1, activeRefs: 2 });
    });

    it("promotes one existing same-generation source request when it becomes uncovered", async () => {
        const h = harness(promotionManifest());
        const gates = new Map<string, ReturnType<typeof deferred<PreparedSplatSource>>>();
        const requests: SplatSourceRequest[] = [];
        const request = vi.fn((value: SplatSourceRequest) => {
            requests.push(value);
            const gate = deferred<PreparedSplatSource>();
            gates.set(value.url, gate);
            return gate.promise;
        });
        const promote = vi.fn<SplatStreamRequestManager["promote"]>(() => true);
        const requestManager: SplatStreamRequestManager = {
            cpuBytes: 0,
            fetchedBytes: 0,
            pendingRequests: 0,
            queuedFiles: 0,
            disposed: false,
            request,
            promote,
            cancel: vi.fn(),
            dispose: vi.fn(),
        };
        const stream = await loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
            maxSplats: 20,
            screenError: 0.001,
            _runtime: {
                fetch: h.fetch,
                requestManager,
                createGpuState: () => h.gpu,
                buildRenderable: h.buildRenderable,
                queueDone: () => h.queueGate.promise,
            },
        });
        void stream.firstFrameReady.catch(() => undefined);
        attachGaussianSplatStream(h.scene, stream);
        await h.scene._deferredBuilders[0]!();
        const bootstrapRequest = requests[0]!;
        gates.get(bootstrapRequest.url)!.resolve(prepared(stream._sourceStates[bootstrapRequest.fileId]!.source, bootstrapRequest.generation));
        await vi.waitFor(() => expect(stream.stats.coveredLeaves).toBe(1));

        h.camera.fov = 0.25;
        const mutableCamera = h.camera as Camera & { worldMatrix: Float32Array; worldMatrixVersion: number };
        mutableCamera.worldMatrix[12] = -0.5;
        mutableCamera.worldMatrixVersion++;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        h.getDraw()(Promise.resolve(true));
        await vi.waitFor(() => expect(requests.some((value) => value.url.endsWith("/shared/meta.json"))).toBe(true));
        const sharedRequest = requests.find((value) => value.url.endsWith("/shared/meta.json"))!;
        expect(sharedRequest.priority).toBe(SplatRequestPriority.Upgrade);
        const sharedState = stream._sourceStates[sharedRequest.fileId]!;
        const generation = sharedState.generation;
        const preparation = sharedState.request;

        mutableCamera.worldMatrix[12] = 0.5;
        mutableCamera.worldMatrixVersion++;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(promote).toHaveBeenCalledWith(sharedRequest.url, generation, SplatRequestPriority.Uncovered, expect.any(Number));
        expect(Number.isFinite(promote.mock.calls[0]![3])).toBe(true);
        expect(request.mock.calls.filter(([value]) => value.url === sharedRequest.url)).toHaveLength(1);
        expect(sharedState.generation).toBe(generation);
        expect(sharedState.request).toBe(preparation);
        disposeGaussianSplatStream(h.scene, stream);
    });

    it("rejects bootstrap when an aliased environment cannot fit after a successful coarse signal", async () => {
        const h = harness(sharedEnvironmentSourceManifest(), 3);
        const stream = await loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
            maxSplats: 3,
            screenError: 0.001,
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
        h.calls[0]!.gate.resolve(prepared(h.calls[0]!.source, h.calls[0]!.generation, 4));
        await vi.waitFor(() => expect(stream._leafStates[0]!.displayed?.count).toBe(1));

        h.getDraw()(Promise.resolve(true));
        await expect(stream.firstFrameReady).rejects.toThrow("resident environment exceeds admitted GPU capacity");
        expect(stream.stats.phase).toBe("error");
        expect(stream.stats.error?.message).toContain("resident environment exceeds admitted GPU capacity");
        expect(stream._disposed).toBe(true);
    });

    it("holds an accepted replacement until the exact per-leaf deadline without duplicate source work", async () => {
        const h = harness(twoCoolingLeavesManifest());
        const stream = await attachAndBuild(h, false, 250);
        const sparse = h.calls.find((call) => call.source.url.includes("/sparse/"))!;
        const fine = h.calls.find((call) => call.source.url.includes("/fine/"))!;
        sparse.gate.resolve(prepared(sparse.source, sparse.generation));
        fine.gate.resolve(prepared(fine.source, fine.generation));
        await vi.waitFor(() => expect(stream._leafStates.map((state) => state.displayed?.fileId)).toEqual([fine.source.id, fine.source.id]));
        expect(stream._leafStates.map((state) => state.lodCooldownUntil)).toEqual([260, 260]);

        const requestCount = h.calls.length;
        stream.screenError = 1_000_000;
        h.setNow(200);
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream.stats.visibleLeaves).toBe(2);
        expect(stream._leafStates.map((state) => state.cooldownHeld)).toEqual([true, true]);
        expect(stream._leafStates.map((state) => state.lodCooldownUntil)).toEqual([260, 260]);

        stream._leafStates[0]!.target = stream._manifest.leaves[0]!.alternatives[0]!;
        stream._leafStates[0]!.pending = stream._manifest.leaves[0]!.alternatives[0]!;
        h.setNow(201);
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream._leafStates[0]!.pending).toBeNull();
        expect(stream._leafStates[0]!.displayed?.fileId).toBe(fine.source.id);
        expect(stream._generationPressure).toBe(false);
        expect(stream._leafStates.map((state) => state.lodCooldownUntil)).toEqual([260, 260]);

        h.setNow(259);
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream._leafStates.map((state) => state.displayed?.fileId)).toEqual([fine.source.id, fine.source.id]);
        expect(stream._leafStates.map((state) => state.target.fileId)).toEqual([fine.source.id, fine.source.id]);
        expect(stream._leafStates.map((state) => state.lodCooldownUntil)).toEqual([260, 260]);
        expect(stream.stats.phase).toBe("streaming");
        expect(stream._generationPressure).toBe(false);
        expect(h.calls).toHaveLength(requestCount);

        const aggregateComputations = stream._selectionAggregateComputations;
        h.setNow(260);
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream._leafStates.map((state) => state.displayed?.count)).toEqual([1, 1]);
        expect(stream._leafStates.map((state) => state.lodCooldownUntil)).toEqual([510, 510]);
        expect(stream._selectionAggregateComputations).toBeGreaterThan(aggregateComputations);
        expect(h.calls).toHaveLength(requestCount);

        void stream.firstFrameReady.catch(() => {});
        disposeGaussianSplatStream(h.scene, stream);
        expect(stream._leafStates.every((state) => state.lodCooldownUntil === 0 && state.pending === null)).toBe(true);
    });

    it("discards an active hold when the mutable shared budget requires an immediate reduction", async () => {
        const h = harness(twoCoolingLeavesManifest());
        const stream = await attachAndBuild(h, false, 250);
        for (const call of h.calls.slice(1)) {
            call.gate.resolve(prepared(call.source, call.generation));
        }
        await vi.waitFor(() => expect(stream._leafStates[0]!.displayed?.count).toBe(2));

        stream.screenError = 1_000_000;
        h.setNow(100);
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream._leafStates[0]!.cooldownHeld).toBe(true);

        stream.maxSplats = 2;
        h.setNow(101);
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream._leafStates.map((state) => state.displayed?.count)).toEqual([1, 1]);
        expect(stream._generationPressure).toBe(false);
    });

    it("reuses exact per-view metrics and the aggregate solve while lifecycle updates continue", async () => {
        const h = harness();
        const stream = await attachAndBuild(h);
        const update = (): void => h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        update();
        update();
        const metrics = stream._selectionMetricsComputations;
        const aggregates = stream._selectionAggregateComputations;
        for (let frame = 0; frame < 4; frame++) {
            h.scene._beforeRender[0]!(16);
            update();
        }
        expect(stream._selectionMetricsComputations).toBe(metrics);
        expect(stream._selectionAggregateComputations).toBe(aggregates);

        const mutableCamera = h.camera as Camera & { worldMatrix: Float32Array; worldMatrixVersion: number };
        mutableCamera.worldMatrix[12] = 0.05;
        mutableCamera.worldMatrixVersion++;
        update();
        expect(stream._selectionMetricsComputations).toBe(metrics + 1);
        const cameraAggregates = stream._selectionAggregateComputations;

        stream.position.x = 0.125;
        update();
        expect(stream._selectionMetricsComputations).toBe(metrics + 2);
        expect(stream._selectionAggregateComputations).toBeGreaterThan(cameraAggregates);

        const policyMetrics = stream._selectionMetricsComputations;
        stream.screenError *= 2;
        h.getUpdate()({ targetWidth: 100, targetHeight: 80, _camera: h.camera });
        expect(stream._selectionMetricsComputations).toBe(policyMetrics + 1);

        const extraBinding = {};
        const beforeBinding = stream._selectionAggregateComputations;
        h.getUpdate()({ targetWidth: 100, targetHeight: 80, _camera: h.camera }, extraBinding);
        expect(stream._selectionAggregateComputations).toBeGreaterThan(beforeBinding);
        h.scene._beforeRender[0]!(16);
        h.scene._beforeRender[0]!(16);
        const beforeRemoval = stream._selectionAggregateComputations;
        h.getUpdate()({ targetWidth: 100, targetHeight: 80, _camera: h.camera });
        expect(stream._selectionAggregateComputations).toBeGreaterThan(beforeRemoval);
        const beforeReadditionMetrics = stream._selectionMetricsComputations;
        h.getUpdate()({ targetWidth: 100, targetHeight: 80, _camera: h.camera }, extraBinding);
        expect(stream._selectionMetricsComputations).toBe(beforeReadditionMetrics + 1);

        const fine = h.calls.find((call) => call.source.url.includes("/fine/"))!;
        const sourceMetrics = stream._selectionMetricsComputations;
        const sourceAggregates = stream._selectionAggregateComputations;
        fine.gate.resolve(prepared(fine.source, fine.generation));
        await vi.waitFor(() => expect(stream._sourceStates[fine.source.id]!.state).toBe("resident"));
        h.getUpdate()({ targetWidth: 100, targetHeight: 80, _camera: h.camera }, extraBinding);
        expect(stream._selectionMetricsComputations).toBe(sourceMetrics);
        expect(stream._selectionAggregateComputations).toBeGreaterThan(sourceAggregates);
    });

    it("publishes a complete 80/10 to 10/80 replacement without transient overflow", () => {
        const states = [
            { visible: true, displayed: representation(0, 1, 80), pending: representation(0, 0, 10) },
            { visible: true, displayed: representation(1, 1, 10), pending: representation(1, 0, 80) },
        ] as StreamLeafRuntime[];
        expect(commitSplatStreamPendingRepresentations(states, 1, 100)).toBe(true);
        expect(states.map((state) => state.displayed?.count)).toEqual([10, 80]);
        expect(states.map((state) => state.pending)).toEqual([null, null]);
    });

    it("retains descriptors when a newly visible generation exceeds capacity before replacements arrive", () => {
        const states = [
            { visible: true, displayed: representation(0, 0, 80), pending: null },
            { visible: true, displayed: representation(1, 0, 80), pending: null },
        ] as StreamLeafRuntime[];
        expect(commitSplatStreamPendingRepresentations(states, 1, 100)).toBe(false);
        expect(states.map((state) => state.displayed?.count)).toEqual([80, 80]);
    });

    it("stages all required reductions before validating an environment-reduced foreground capacity", () => {
        const states = [30, 30, 15, 15].map(
            (count, leafId) =>
                ({
                    visible: true,
                    displayed: representation(leafId, 1, count),
                    pending: representation(leafId, 0, leafId < 2 ? 25 : 15),
                }) as StreamLeafRuntime
        );
        expect(commitSplatStreamPendingRepresentations(states, 1, 80)).toBe(true);
        expect(states.map((state) => state.displayed?.count)).toEqual([25, 25, 15, 15]);
        expect(states.map((state) => state.pending)).toEqual([null, null, null, null]);
    });

    it("publishes all camera-selected reductions after environment residency lowers foreground capacity", async () => {
        const h = harness(combinedReductionManifest(), 100);
        const stream = await loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
            maxSplats: 100,
            screenError: 0.001,
            lodCooldownMs: 250,
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
        h.calls[0]!.gate.resolve(prepared(h.calls[0]!.source, h.calls[0]!.generation, 100));
        await vi.waitFor(() => expect(stream.stats.coveredLeaves).toBe(4));
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        h.getDraw()();
        await vi.waitFor(() => expect(h.calls).toHaveLength(3));
        const fine = h.calls.find((call) => call.source.url.endsWith("/fine/meta.json"))!;
        const environment = h.calls.find((call) => call.source.url.endsWith("/environment/meta.json"))!;
        fine.gate.resolve(prepared(fine.source, fine.generation, 100));
        await vi.waitFor(() => expect(stream._leafStates.map((state) => state.displayed?.count)).toEqual([30, 30, 16, 16]));

        environment.gate.resolve(prepared(environment.source, environment.generation, 20));
        await vi.waitFor(() => expect(stream._sourceStates[environment.source.id]!.state).toBe("resident"));
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream._leafStates.map((state) => state.displayed?.count)).toEqual([25, 25, 15, 15]);
        expect(stream._gpu.count).toBe(100);
        expect(stream.stats.error).toBeNull();
    });

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

    it("retires the initial GPU allocation when gather descriptor headroom cannot be held", async () => {
        const h = harness();
        const destroyCanonical = vi.fn();
        const canonical = { destroy: destroyCanonical } as unknown as GPUBuffer;
        let ledger!: SplatStreamGpuState["ledger"];
        const loading = loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
            maxSplats: 20,
            maxGpuBytes: 1024,
            _runtime: {
                fetch: h.fetch,
                createGpuState: (_engine, capacity, _maxGpuBytes, createdLedger) => {
                    ledger = createdLedger!;
                    expect(ledger.tryReserve(900)).toBe(true);
                    return {
                        ...h.gpu,
                        capacity,
                        canonical,
                        ledger,
                        gpuBytes: 900,
                        gatherParameterHoldBytes: 0,
                        gatherParametersInFlight: 0,
                        gatherHoldReleasePending: false,
                        passHoldBytes: 0,
                        disposed: false,
                    } as SplatStreamGpuState;
                },
            },
        });
        await expect(loading).rejects.toThrow("protect submission-local gather parameters");
        expect(ledger.residentBytes).toBe(0);
        expect(ledger.allocatedBytes).toBe(900);
        const retirements = (h.engine as EngineContext & { _retirements?: Array<() => void> })._retirements!;
        expect(retirements).toHaveLength(1);
        retirements.splice(0).forEach((retire) => retire());
        expect(destroyCanonical).toHaveBeenCalledOnce();
        expect(ledger.allocatedBytes).toBe(0);
        expect(ledger.heldBytes).toBe(0);
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
        expect(stream.maxSplats).toBe(h.gpu.capacity);
        expect(stream.stats.error).toBeNull();
        expect(stream._cache.entries.get(environment.source.url)!.activeRefs).toBeGreaterThan(0);
    });

    it("aggregates delayed source demand across disjoint camera bindings", async () => {
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

        h.camera.fov = 0.25;
        const mutableCamera = h.camera as Camera & { worldMatrix: Float32Array; worldMatrixVersion: number };
        const updateCameraA = createSplatStreamSelectionUpdate(h.getUpdate());
        const updateCameraB = createSplatStreamSelectionUpdate(h.getUpdate());
        mutableCamera.worldMatrix[12] = -0.5;
        mutableCamera.worldMatrixVersion++;
        updateCameraA({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        h.getDraw()(Promise.resolve(true));
        expect(stream._coarseSubmitted).toBe(true);
        await vi.waitFor(() => expect(stream._refinementEnabled).toBe(true));

        mutableCamera.worldMatrix[12] = 0.5;
        mutableCamera.worldMatrixVersion++;
        updateCameraB({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        await vi.waitFor(() => expect(h.calls).toHaveLength(3));
        const delayed = h.calls.slice(1);
        const generations = delayed.map((call) => call.generation);
        expect(new Set(delayed.map((call) => call.source.url))).toEqual(new Set(["https://assets.test/sparse/meta.json", "https://assets.test/fine/meta.json"]));

        h.scene._beforeRender[0]!(16);
        updateCameraB({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(delayed.map((call) => stream._sourceStates[call.source.id]!.demandCount)).toEqual([1, 1]);
        expect(delayed.map((call) => stream._sourceStates[call.source.id]!.generation)).toEqual(generations);
        expect(delayed.every((call) => stream._sourceStates[call.source.id]!.request)).toBe(true);
    });

    it("solves disjoint material binding demand once before publishing under shared capacity", async () => {
        const h = harness(multiCameraCapacityManifest(), 100);
        const stream = await loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
            maxSplats: 100,
            screenError: 0.001,
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
        h.calls[0]!.gate.resolve(prepared(h.calls[0]!.source, h.calls[0]!.generation, 100));
        await vi.waitFor(() => expect(stream.stats.coveredLeaves).toBe(1));
        await vi.waitFor(() => expect(h.gpu.count).toBeGreaterThan(0));
        h.getDraw()(Promise.resolve(true));
        await vi.waitFor(() => expect(stream._refinementEnabled).toBe(true));

        h.camera.fov = 0.25;
        const mutableCamera = h.camera as Camera & { worldMatrix: Float32Array; worldMatrixVersion: number };
        const updateCameraA = createSplatStreamSelectionUpdate(h.getUpdate());
        const updateCameraB = createSplatStreamSelectionUpdate(h.getUpdate());
        mutableCamera.worldMatrix[12] = -0.5;
        mutableCamera.worldMatrixVersion++;
        updateCameraA({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        await vi.waitFor(() => expect(h.calls.some((call) => call.source.url.endsWith("/a-fine/meta.json"))).toBe(true));
        const aFine = h.calls.find((call) => call.source.url.endsWith("/a-fine/meta.json"))!;
        aFine.gate.resolve(prepared(aFine.source, aFine.generation, 100));
        await vi.waitFor(() => expect(stream._leafStates[0]!.displayed?.count).toBe(70));

        h.scene._beforeRender[0]!(16);
        updateCameraA({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        mutableCamera.worldMatrix[12] = 0.5;
        mutableCamera.worldMatrixVersion++;
        updateCameraB({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        await vi.waitFor(() => expect(h.calls.some((call) => call.source.url.endsWith("/b-coarse/meta.json"))).toBe(true));
        const bCoarse = h.calls.find((call) => call.source.url.endsWith("/b-coarse/meta.json"))!;
        bCoarse.gate.resolve(prepared(bCoarse.source, bCoarse.generation, 100));
        await vi.waitFor(() => expect(stream._leafStates[1]!.displayed?.count).toBe(40));
        updateCameraB({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        await vi.waitFor(() => expect(h.calls.some((call) => call.source.url.endsWith("/b-fine/meta.json"))).toBe(true));
        const bFine = h.calls.find((call) => call.source.url.endsWith("/b-fine/meta.json"))!;
        bFine.gate.resolve(prepared(bFine.source, bFine.generation, 100));
        await vi.waitFor(() => expect(stream._leafStates.map((state) => state.displayed?.count)).toEqual([20, 70]));

        expect(stream._leafStates.map((state) => state.target.count)).toEqual([20, 70]);
        expect(stream.stats.selectedSplats).toBe(90);
        expect(stream._gpu.count).toBe(90);
        expect(stream.stats.error).toBeNull();
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
        const filler = stream._gpu.ledger.maxBytes - stream._gpu.ledger.allocatedBytes - stream._gpu.ledger.heldBytes - 10;
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

    it("requests visible coarse coverage before readiness when the primary bootstrap is offscreen", async () => {
        const h = harness(offscreenBootstrapManifest());
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
        expect(h.calls[0]!.source.url).toContain("/broad/");
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(h.calls.map((call) => call.source.url)).toEqual(["https://assets.test/broad/meta.json", "https://assets.test/visible/meta.json"]);
        const visible = h.calls[1]!;
        visible.gate.resolve(prepared(visible.source, visible.generation));
        await vi.waitFor(() => expect(h.gpu.count).toBe(1));
        h.getDraw()(Promise.resolve(true));
        h.queueGate.resolve();
        await expect(stream.firstFrameReady).resolves.toBeUndefined();
        expect(stream.stats.error).toBeNull();
    });

    it("requests an uncovered leaf's coarse source before its unaffordable fine target", async () => {
        const h = harness(uncoveredFineManifest());
        const stream = await attachAndBuild(h);
        expect(h.calls[1]!.source.url).toBe("https://assets.test/coarse/meta.json");
        expect(h.calls.some((call) => call.source.url.endsWith("/uncovered-fine/meta.json"))).toBe(false);
        const coarse = h.calls[1]!;
        coarse.gate.resolve(prepared(coarse.source, coarse.generation));
        await vi.waitFor(() => expect(stream.stats.coveredLeaves).toBe(2));
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(h.calls.some((call) => call.source.url.endsWith("/uncovered-fine/meta.json"))).toBe(true);
    });

    it("uses resident coarse coverage when resident fine cannot fit, then recovers after the missing downgrade arrives", async () => {
        const h = harness(residentFineFallbackManifest(), 80);
        const stream = await loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
            maxSplats: 80,
            maxConcurrentRequests: 4,
            maxConcurrentDecodes: 4,
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
        expect(h.calls[0]!.source.url).toBe("https://assets.test/b-coarse/meta.json");
        h.calls[0]!.gate.resolve(prepared(h.calls[0]!.source, h.calls[0]!.generation, 100));
        await vi.waitFor(() => expect(stream.stats.coveredLeaves).toBe(1));
        await vi.waitFor(() => expect(h.gpu.intervals.length).toBe(1));
        await vi.waitFor(() => expect(h.gpu.count).toBeGreaterThan(0));
        await vi.waitFor(() => expect(stream._sourceStates[0]!.request).toBeNull());
        h.getDraw()(Promise.resolve(true));
        await vi.waitFor(() => expect(stream._refinementEnabled).toBe(true));
        h.camera.fov = 0.25;
        const mutableCamera = h.camera as Camera & { worldMatrix: Float32Array; worldMatrixVersion: number };
        const updateCameraA = createSplatStreamSelectionUpdate(h.getUpdate());
        const updateCameraB = createSplatStreamSelectionUpdate(h.getUpdate());
        mutableCamera.worldMatrix[12] = -0.5;
        mutableCamera.worldMatrixVersion++;
        updateCameraA({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream._leafStates.map((state) => state.target.count)).toEqual([70, 5]);
        expect(stream._leafStates.map((state) => state.visible)).toEqual([true, false]);
        await vi.waitFor(() => expect(h.calls.some((call) => call.source.url.endsWith("/a-coarse/meta.json"))).toBe(true));
        const aCoarseCall = h.calls.find((call) => call.source.url.endsWith("/a-coarse/meta.json"))!;
        aCoarseCall.gate.resolve(prepared(aCoarseCall.source, aCoarseCall.generation, 100));
        await vi.waitFor(() => expect(stream._leafStates[0]!.displayed?.count).toBe(20));
        updateCameraA({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        await vi.waitFor(() => expect(h.calls.some((call) => call.source.url.endsWith("/a-fine/meta.json"))).toBe(true));
        const aFineCall = h.calls.find((call) => call.source.url.endsWith("/a-fine/meta.json"))!;
        aFineCall.gate.resolve(prepared(aFineCall.source, aFineCall.generation, 100));
        await vi.waitFor(() => expect(stream._leafStates[0]!.displayed?.count).toBe(70));

        mutableCamera.worldMatrix[12] = 0.5;
        mutableCamera.worldMatrixVersion++;
        updateCameraB({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        await vi.waitFor(() => expect(stream._leafStates[1]!.displayed?.count).toBe(5));
        updateCameraB({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        await vi.waitFor(() => expect(h.calls.some((call) => call.source.url.endsWith("/b-fine/meta.json"))).toBe(true));
        const bFineCall = h.calls.find((call) => call.source.url.endsWith("/b-fine/meta.json"))!;

        const aCoarse = stream._sourceStates[0]!;
        const aFine = stream._sourceStates[1]!;
        const bCoarse = stream._sourceStates[2]!;
        const bMid = stream._sourceStates[3]!;
        const bFine = stream._sourceStates[4]!;
        injectResidentSource(stream, bMid.source.id, 100);
        const aCoarseEntry = stream._cache.entries.get(aCoarse.source.url)!;
        aCoarseEntry.pinCount = aCoarseEntry.displayedRefs = aCoarseEntry.pendingRefs = aCoarseEntry.activeRefs = 0;
        expect(evictSplatSource(stream._cache, aCoarse.source.url)).toBe(true);
        forgetEvictedSplatStreamSource(stream, aCoarse.source.url);
        stream._leafStates[0]!.displayed = stream._manifest.leaves[0]!.alternatives[1]!;
        stream._leafStates[1]!.displayed = null;
        h.gpu.intervals = [{ source: aFine.gpu!, sourceOffset: 0, count: 70, destinationOffset: 0 }];
        h.gpu.count = 70;
        const bCoarseEntry = stream._cache.entries.get(bCoarse.source.url)!;
        bCoarseEntry.displayedRefs = 0;
        bCoarseEntry.activeRefs = 0;

        bFineCall.gate.resolve(prepared(bFineCall.source, bFineCall.generation, 100));
        await vi.waitFor(() => expect(stream._sourceStates[bFineCall.source.id]!.state).toBe("resident"));
        updateCameraB({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream._leafStates[1]!.visible).toBe(true);
        expect(stream._leafStates[1]!.target.count).toBe(30);
        expect(stream._leafStates.map((state) => state.displayed?.count ?? 0)).toEqual([70, 5]);
        expect(stream._leafStates[1]!.pending).toBeNull();
        expect(stream._cache.entries.get(bFine.source.url)!.pendingRefs).toBe(0);
        expect(stream._cache.entries.get(bMid.source.url)!.pendingRefs).toBe(0);
        expect(stream._cache.entries.get(bCoarse.source.url)!.displayedRefs).toBeGreaterThan(0);
        expect({
            generationPressure: stream._generationPressure,
            targetFile: stream._leafStates[1]!.target.fileId,
            displayedFile: stream._leafStates[1]!.displayed!.fileId,
            targetSourceState: stream._sourceStates[stream._leafStates[1]!.target.fileId]!.state,
        }).toEqual({ generationPressure: true, targetFile: bFine.source.id, displayedFile: bCoarse.source.id, targetSourceState: "resident" });
        expect(stream.stats.phase).toBe("budget-limited");

        const aRetry = h.calls.filter((call) => call.source.url.endsWith("/a-coarse/meta.json")).at(-1)!;
        expect(aRetry).not.toBe(h.calls[0]);

        aRetry.gate.resolve(prepared(aRetry.source, aRetry.generation, 100));
        await vi.waitFor(() => expect(stream._leafStates[0]!.displayed?.count).toBe(20));
        updateCameraB({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream._leafStates.map((state) => state.displayed?.count)).toEqual([20, 30]);
        expect(stream._generationPressure).toBe(false);
        expect(stream.stats.phase).toBe("idle");
    });

    it("reports resident target pressure below capacity and clears it when camera demand withdraws", async () => {
        const h = harness(residentFineFallbackManifest(true), 80);
        const stream = await loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
            maxSplats: 80,
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
        h.calls[0]!.gate.resolve(prepared(h.calls[0]!.source, h.calls[0]!.generation, 100));
        await vi.waitFor(() => expect(h.gpu.count).toBeGreaterThan(0));
        h.getDraw()(Promise.resolve(true));
        await vi.waitFor(() => expect(stream._refinementEnabled).toBe(true));

        h.camera.fov = 0.25;
        const mutableCamera = h.camera as Camera & { worldMatrix: Float32Array; worldMatrixVersion: number };
        const updateCamera = createSplatStreamSelectionUpdate(h.getUpdate());
        mutableCamera.worldMatrix[12] = -0.5;
        mutableCamera.worldMatrixVersion++;
        updateCamera({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        await vi.waitFor(() => expect(h.calls.some((call) => call.source.url.endsWith("/a-coarse/meta.json"))).toBe(true));
        const aCoarseCall = h.calls.find((call) => call.source.url.endsWith("/a-coarse/meta.json"))!;
        aCoarseCall.gate.resolve(prepared(aCoarseCall.source, aCoarseCall.generation, 100));
        await vi.waitFor(() => expect(stream._leafStates[0]!.displayed?.count).toBe(20));
        updateCamera({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        await vi.waitFor(() => expect(h.calls.some((call) => call.source.url.endsWith("/a-fine/meta.json"))).toBe(true));
        await vi.waitFor(() => expect(h.calls.some((call) => call.source.url.endsWith("/environment/meta.json"))).toBe(true));
        const aFineCall = h.calls.find((call) => call.source.url.endsWith("/a-fine/meta.json"))!;
        const environmentCall = h.calls.find((call) => call.source.url.endsWith("/environment/meta.json"))!;

        environmentCall.gate.resolve(prepared(environmentCall.source, environmentCall.generation, 20));
        await vi.waitFor(() => expect(stream._sourceStates[environmentCall.source.id]!.state).toBe("resident"));
        aFineCall.gate.resolve(prepared(aFineCall.source, aFineCall.generation, 100));
        await vi.waitFor(() => expect(stream._sourceStates[aFineCall.source.id]!.state).toBe("resident"));

        expect(stream._leafStates[0]!.displayed?.count).toBe(20);
        expect(stream._leafStates[0]!.target.count).toBe(70);
        expect(stream._leafStates[0]!.pending).toBeNull();
        expect(stream._gpu.count).toBeLessThanOrEqual(60);
        expect(stream._generationPressure).toBe(true);
        expect(stream.stats.phase).toBe("budget-limited");

        mutableCamera.worldMatrix[12] = 0.5;
        mutableCamera.worldMatrixVersion++;
        updateCamera({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        await vi.waitFor(() => expect(h.calls.some((call) => call.source.url.endsWith("/b-fine/meta.json"))).toBe(true));
        const bFineCall = h.calls.find((call) => call.source.url.endsWith("/b-fine/meta.json"))!;
        bFineCall.gate.resolve(prepared(bFineCall.source, bFineCall.generation, 100));
        await vi.waitFor(() => expect(stream._leafStates[1]!.displayed).toEqual(stream._leafStates[1]!.target));
        expect(stream.stats.visibleLeaves).toBe(1);
        expect(stream._generationPressure).toBe(false);
        expect(stream.stats.phase).toBe("idle");
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
        stream.maxSplats = h.gpu.capacity + 1;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream.stats.error?.message).toContain("decode failed");
        stream.maxSplats = h.gpu.capacity;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream.stats.error?.message).toContain("decode failed");
    });

    it("preserves a source failure that arrives while a transient selection error is visible", async () => {
        const h = harness();
        const stream = await attachAndBuild(h);
        const fine = h.calls.find((call) => call.source.url.includes("fine"))!;

        stream.maxSplats = h.gpu.capacity + 1;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream.stats.error?.message).toContain("exceeds immutable admitted capacity");
        fine.gate.reject(new Error("terminal decode failed"));
        await vi.waitFor(() => expect(stream.stats.error?.message).toContain("terminal decode failed"));

        stream.maxSplats = h.gpu.capacity;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream.stats.error?.message).toContain("terminal decode failed");
        expect(stream.stats.phase).toBe("error");
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
        expect(stream._leafStates[1]!.displayed).toBeNull();
        expect(stream._cache.entries.get(sparse.source.url)!.displayedRefs).toBe(0);

        mutableCamera.worldMatrix[12] = 0.5;
        mutableCamera.worldMatrixVersion++;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream.stats.visibleLeaves).toBe(1);
        expect(h.gpu.count).toBe(1);
        expect(stream._leafStates[0]!.displayed).toBeNull();
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

    it("preserves content generation for an unchanged interval sequence", async () => {
        const h = harness();
        const stream = await attachAndBuild(h);
        const generation = stream._contentGeneration;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream._contentGeneration).toBe(generation);
        expect(h.gpu.contentGeneration).toBe(generation);
    });

    it("does not rescan leaf or interval protections on unchanged frames", async () => {
        const h = harness();
        const stream = await attachAndBuild(h);
        const refreshes = stream._protectionRefreshes;
        const leafScans = stream._protectionLeafScans;
        const intervalScans = stream._protectionIntervalScans;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream._protectionRefreshes).toBe(refreshes);
        expect(stream._protectionLeafScans).toBe(leafScans);
        expect(stream._protectionIntervalScans).toBe(intervalScans);
    });

    it("recovers a mutable selection error on the same cached view without replacing the valid display", async () => {
        const h = harness();
        const stream = await attachAndBuild(h);
        const intervals = [...h.gpu.intervals];
        const computations = stream._selectionMetricsComputations;
        stream.maxSplats = h.gpu.capacity + 1;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream.stats.phase).toBe("error");
        expect(stream.stats.error?.message).toContain("exceeds immutable admitted capacity");
        expect(h.gpu.intervals).toEqual(intervals);
        expect(h.gpu.count).toBeGreaterThan(0);
        stream.maxSplats = h.gpu.capacity;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream.stats.error).toBeNull();
        expect(stream.stats.phase).not.toBe("error");
        expect(stream._selectionMetricsComputations).toBe(computations);

        h.queueGate.resolve();
        await stream.firstFrameReady;
        stream.screenError = 0;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream.stats.error?.message).toContain("screenError must be finite and greater than zero");
        stream.screenError = 2;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream.stats.error).toBeNull();
        expect(stream.stats.phase).not.toBe("error");
    });

    it("recovers a coarse-baseline budget before readiness and then completes the coarse fence", async () => {
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

        stream.maxSplats = 1;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream.stats.error).toMatchObject({ name: "RangeError", message: expect.stringContaining("visible coarse baseline") });
        expect(stream.stats.phase).toBe("error");
        expect(stream._disposed).toBe(false);
        expect(stream._firstFrameSettled).toBe(false);

        stream.maxSplats = 20;
        h.getUpdate()({ targetWidth: 100, targetHeight: 100, _camera: h.camera });
        expect(stream.stats.error).toBeNull();
        expect(stream.stats.phase).toBe("bootstrap");
        h.getDraw()(Promise.resolve(true));
        h.queueGate.resolve();
        await expect(stream.firstFrameReady).resolves.toBeUndefined();
        expect(stream._disposed).toBe(false);
    });

    it("rejects readiness and disposes work for an orthographic startup selection", async () => {
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
        const ready = stream.firstFrameReady.catch((reason: unknown) => reason);
        h.getUpdate()({
            targetWidth: 100,
            targetHeight: 100,
            _camera: { ...h.camera, ortho: { halfHeight: 1, left: null, right: null, bottom: null, top: null } } as Camera,
        });
        expect(await ready).toMatchObject({ message: expect.stringContaining("orthographic cameras are unsupported") });
        expect(stream._disposed).toBe(true);
        expect(stream.stats.phase).toBe("error");
        expect(stream.stats.error?.message).toContain("orthographic cameras are unsupported");
        expect(h.gpu.disposed).toBe(true);
        const stale = prepared(h.calls[0]!.source, h.calls[0]!.generation);
        h.calls[0]!.gate.resolve(stale);
        await Promise.resolve();
        await Promise.resolve();
        expect(stale.textures.every((texture) => vi.mocked(texture.destroy).mock.calls.length === 1)).toBe(true);
    });

    it("disposes an attached stream when the scene ends before deferred renderable construction", async () => {
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
        expect(h.scene._disposables).toHaveLength(1);
        h.scene._disposables.splice(0).forEach((dispose) => dispose());
        expect(await ready).toMatchObject({ name: "AbortError" });
        expect(stream.stats.phase).toBe("disposed");
        expect(h.buildRenderable).not.toHaveBeenCalled();
    });

    it("disposes two attached streams and a trailing scene callback exactly once during real scene disposal", async () => {
        const h = harness();
        const makeGpu = (): SplatStreamGpuState =>
            ({
                ...h.gpu,
                intervals: [],
                count: 0,
                contentGeneration: 0,
                gatheredGeneration: -1,
                gatherParameterHoldBytes: 0,
                gatherParametersInFlight: 0,
                gatherHoldReleasePending: false,
                disposed: false,
            }) as SplatStreamGpuState;
        const load = () =>
            loadGaussianSplatStream(h.engine, "https://assets.test/lod-meta.json", {
                maxSplats: 20,
                _runtime: { fetch: h.fetch, prepareSource: h.prepareSource, createGpuState: makeGpu },
            });
        const first = await load();
        const second = await load();
        void first.firstFrameReady.catch(() => undefined);
        void second.firstFrameReady.catch(() => undefined);
        attachGaussianSplatStream(h.scene, first);
        attachGaussianSplatStream(h.scene, second);
        const sentinel = vi.fn();
        h.scene._disposables.push(sentinel);
        Object.assign(h.scene, {
            _meshDisposables: new Map(),
            meshes: [],
            _groups: new Map(),
            _prePasses: [],
            _pickSources: [],
            _uniformUpdaters: [],
            _materialSwapQueue: [],
            lights: [],
            animationGroups: [],
            shadowGenerators: [],
            camera: null,
        });
        Object.assign(h.scene.surface, { _renderingContexts: [h.scene] });

        disposeScene(h.scene);
        expect(first._disposed).toBe(true);
        expect(second._disposed).toBe(true);
        expect(sentinel).toHaveBeenCalledOnce();
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
