import { describe, expect, it, vi } from "vitest";

import { renderFrame, setGpuTimingEnabled } from "../../../packages/babylon-lite/src/engine/engine";
import type { EngineContext, RenderingContext } from "../../../packages/babylon-lite/src/engine/engine";
import { getRenderTaskGpuTimings, isRenderTaskGpuTimingSupported, setRenderTaskGpuTimingEnabled } from "../../../packages/babylon-lite/src/engine/gpu-task-timing";
import { installGpuTaskTimer, type GpuTaskTimer } from "../../../packages/babylon-lite/src/engine/gpu-task-timer";
import { createFrameGraph } from "../../../packages/babylon-lite/src/frame-graph/frame-graph";
import type { Pass } from "../../../packages/babylon-lite/src/frame-graph/pass";
import type { Task } from "../../../packages/babylon-lite/src/frame-graph/task";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage" | "GPUMapMode"> & {
    GPUBufferUsage?: { COPY_DST: number; COPY_SRC: number; MAP_READ: number; QUERY_RESOLVE: number };
    GPUMapMode?: { READ: number; WRITE: number };
};
gpuGlobals.GPUBufferUsage ??= { COPY_DST: 0x0008, COPY_SRC: 0x0004, MAP_READ: 0x0001, QUERY_RESOLVE: 0x0200 } as unknown as GPUBufferUsage;
gpuGlobals.GPUMapMode ??= { READ: 0x1, WRITE: 0x2 } as unknown as GPUMapMode;

function makeEngineWithFeatures(features: Iterable<GPUFeatureName>): EngineContext {
    return {
        _device: { features: new Set(features) },
    } as unknown as EngineContext;
}

function makePass(name: string, drawCalls: number, log: string[]): Pass {
    return {
        name,
        _parentTask: undefined!,
        _dependencies: new Set(),
        _executeFunc: null,
        _beforeExecute: null,
        _initialize(): void {
            return;
        },
        _execute(): number {
            log.push(`pass:${name}`);
            return drawCalls;
        },
        _dispose(): void {
            return;
        },
    };
}

function makeTask(engine: EngineContext, name: string, drawCalls: number, log: string[], useTaskExecute: boolean): Task {
    const task: Task = {
        name,
        engine,
        _passes: [],
        record(): void {
            return;
        },
        dispose(): void {
            return;
        },
    };
    if (useTaskExecute) {
        task.execute = () => {
            log.push(`task:${name}`);
            return drawCalls;
        };
    } else {
        const pass = makePass(name, drawCalls, log);
        pass._parentTask = task;
        task._passes.push(pass);
    }
    return task;
}

describe("render-task GPU timing public state", () => {
    it("reports unsupported devices without installing profiler hooks", async () => {
        const engine = makeEngineWithFeatures([]);

        expect(isRenderTaskGpuTimingSupported(engine)).toBe(false);
        expect(getRenderTaskGpuTimings(engine)).toMatchObject({ status: "unsupported", supported: false, enabled: false, tasks: [] });

        const enabled = await setRenderTaskGpuTimingEnabled(engine, true);

        expect(enabled).toMatchObject({ status: "unsupported", supported: false, enabled: false, tasks: [] });
        expect(engine._gpuTaskTimerDisable).toBeUndefined();
    });

    it("treats repeated enable calls as idempotent while profiling is already requested", async () => {
        const engine = makeEngineWithFeatures(["timestamp-query"]);
        engine._gpuTaskTimerWanted = true;
        engine._gpuTaskTimerEpoch = 7;

        const snapshot = await setRenderTaskGpuTimingEnabled(engine, true);

        expect(snapshot).toMatchObject({ status: "pending", supported: true, enabled: true, tasks: [] });
        expect(engine._gpuTaskTimerEpoch).toBe(7);
    });

    it("creates a fresh timer after profiling is disabled and re-enabled", async () => {
        const querySetDestroyers: ReturnType<typeof vi.fn>[] = [];
        const bufferDestroyers: ReturnType<typeof vi.fn>[] = [];
        const device = {
            features: new Set<GPUFeatureName>(["timestamp-query"]),
            createQuerySet: () => {
                const destroy = vi.fn();
                querySetDestroyers.push(destroy);
                return { destroy } as unknown as GPUQuerySet;
            },
            createBuffer: () => {
                const destroy = vi.fn();
                bufferDestroyers.push(destroy);
                return { destroy } as unknown as GPUBuffer;
            },
        } as unknown as GPUDevice;
        const engine = {
            _device: device,
            surfaces: [],
            _surfaces: [],
        } as unknown as EngineContext;

        await setRenderTaskGpuTimingEnabled(engine, true);
        const firstTimer = engine._gpuTaskTimer;

        expect(firstTimer).toBeDefined();
        expect(querySetDestroyers).toHaveLength(1);
        expect(bufferDestroyers).toHaveLength(1);

        await setRenderTaskGpuTimingEnabled(engine, false);

        expect(querySetDestroyers[0]).toHaveBeenCalledOnce();
        expect(bufferDestroyers[0]).toHaveBeenCalledOnce();
        expect(engine._gpuTaskTimer).toBeUndefined();

        await setRenderTaskGpuTimingEnabled(engine, true);

        expect(engine._gpuTaskTimer).toBeDefined();
        expect(engine._gpuTaskTimer).not.toBe(firstTimer);
        expect(querySetDestroyers).toHaveLength(2);
        expect(bufferDestroyers).toHaveLength(2);

        await setRenderTaskGpuTimingEnabled(engine, false);
    });

    it("dispatches the shared GPU timing resolver exactly once per rendered frame", () => {
        const frameResolve = vi.fn();
        const taskResolve = vi.fn();
        const resolveGpuTimers = vi.fn(() => {
            frameResolve();
            taskResolve();
        });
        const texture = {
            width: 1,
            height: 1,
            createView: () => ({}) as GPUTextureView,
        } as unknown as GPUTexture;
        const encoder = {
            finish: () => ({}) as GPUCommandBuffer,
        } as unknown as GPUCommandEncoder;
        const engine = {
            _device: {
                createCommandEncoder: () => encoder,
                queue: { submit: () => undefined },
            },
            _context: { getCurrentTexture: () => texture },
            scRT: {},
            format: "rgba8unorm",
            _renderingContexts: [
                {
                    _update: () => undefined,
                    _drawCallsPre: 0,
                    _record: () => 0,
                },
            ],
            _cbs: [{} as GPUCommandBuffer],
            drawCallCount: 0,
            _gpuTimerResolve: resolveGpuTimers,
            _gpuTaskTimerResolve: taskResolve,
        } as unknown as EngineContext;
        Object.assign(engine, { surfaces: [engine], _surfaces: [engine] });

        renderFrame(engine, 16);

        expect(resolveGpuTimers).toHaveBeenCalledOnce();
        expect(frameResolve).toHaveBeenCalledOnce();
        expect(taskResolve).toHaveBeenCalledOnce();
    });

    it("keeps task timing on the shared resolver when frame timing is disabled", () => {
        const taskResolve = vi.fn();
        const engine = {
            gpuFrameTimeMs: 12,
            _gpuTimerBegin: vi.fn(),
            _gpuTimerEnd: vi.fn(),
            _gpuTimerResolve: vi.fn(),
            _gpuTaskTimerResolve: taskResolve,
        } as unknown as EngineContext;

        setGpuTimingEnabled(engine, false);

        expect(engine.gpuFrameTimeMs).toBe(0);
        expect(engine._gpuTimerBegin).toBeUndefined();
        expect(engine._gpuTimerEnd).toBeUndefined();
        expect(engine._gpuTimerResolve).toBe(taskResolve);
        expect(engine._gpuTaskTimerResolve).toBe(taskResolve);
    });
});

describe("GPU task timing installer", () => {
    it("wraps registered frame graphs, publishes task durations, and restores on disable", async () => {
        const log: string[] = [];
        const engine = makeEngineWithFeatures(["timestamp-query"]);
        const timestampWrites: NonNullable<GPUComputePassDescriptor["timestampWrites"]>[] = [];
        engine._currentEncoder = {
            beginComputePass: (descriptor?: GPUComputePassDescriptor) => {
                timestampWrites.push(descriptor!.timestampWrites!);
                return { end: () => undefined } as unknown as GPUComputePassEncoder;
            },
        } as unknown as GPUCommandEncoder;

        const fg = createFrameGraph(engine);
        const originalExecute = fg.execute;
        const disabledTask = makeTask(engine, "disabled-pass", 7, log, false);
        disabledTask.executionEnabled = false;
        fg._tasks.push(makeTask(engine, "task-execute", 2, log, true), disabledTask, makeTask(engine, "pass-execute", 3, log, false));
        const surface = { _renderingContexts: [{ frameGraph: fg }] };
        Object.assign(engine, { surfaces: [surface], _surfaces: [surface] });

        const timestamps = new BigUint64Array([0n, 1_000_000n, 2_000_000n, 4_500_000n]);
        const readback = {
            mapAsync: () => Promise.resolve(),
            getMappedRange: () => timestamps.buffer,
            unmap: () => undefined,
            destroy: () => undefined,
        } as unknown as GPUBuffer;
        const timer: GpuTaskTimer = {
            device: {
                createCommandEncoder: () =>
                    ({
                        resolveQuerySet: () => undefined,
                        copyBufferToBuffer: () => undefined,
                        finish: () => ({}) as GPUCommandBuffer,
                    }) as unknown as GPUCommandEncoder,
                queue: { submit: () => undefined },
            } as unknown as GPUDevice,
            querySet: { destroy: () => undefined } as unknown as GPUQuerySet,
            resolveBuffer: { destroy: () => undefined } as unknown as GPUBuffer,
            readbackPool: [readback],
            pendingReadbacks: new Set(),
            records: [],
            wrappedGraphs: [],
            patchedContextLists: [],
            patchedSurfaceLists: [],
            taskCapacity: 64,
            currentEncoder: null,
            frameIndex: 0,
            droppedTaskCount: 0,
            inFlight: 0,
            skipFrame: false,
            disposed: false,
        };
        const snapshots: unknown[] = [];
        let previousResolveCalls = 0;
        const previousResolve = () => {
            previousResolveCalls++;
            engine._gpuTaskTimerResolve?.();
        };
        engine._gpuTimerResolve = previousResolve;
        const restore = installGpuTaskTimer(timer, engine, (snapshot) => snapshots.push(snapshot));

        expect(fg.execute()).toBe(5);
        engine._gpuTimerResolve?.();
        await Promise.resolve();
        await Promise.resolve();

        expect(fg.execute).not.toBe(originalExecute);
        expect(previousResolveCalls).toBe(1);
        expect(log).toEqual(["task:task-execute", "pass:pass-execute"]);
        expect(timestampWrites.length).toBe(4);
        expect(snapshots).toEqual([
            {
                status: "available",
                supported: true,
                enabled: true,
                frameIndex: 1,
                tasks: [
                    { index: 0, name: "task-execute", durationMs: 1 },
                    { index: 1, name: "pass-execute", durationMs: 2.5 },
                ],
                droppedTaskCount: 0,
                error: undefined,
            },
        ]);

        restore();
        expect(fg.execute).toBe(originalExecute);
        expect(engine._gpuTimerResolve).toBe(previousResolve);
        expect(engine._gpuTaskTimerResolve).toBeUndefined();
    });

    it("wraps frame graphs registered on surfaces added after install", () => {
        const engine = makeEngineWithFeatures(["timestamp-query"]);
        const primarySurface = { _renderingContexts: [] as RenderingContext[] };
        const surfaces = [primarySurface] as unknown as EngineContext["_surfaces"];
        Object.assign(engine, { surfaces, _surfaces: surfaces });
        const timer: GpuTaskTimer = {
            device: {} as GPUDevice,
            querySet: { destroy: () => undefined } as unknown as GPUQuerySet,
            resolveBuffer: { destroy: () => undefined } as unknown as GPUBuffer,
            readbackPool: [],
            pendingReadbacks: new Set(),
            records: [],
            wrappedGraphs: [],
            patchedContextLists: [],
            patchedSurfaceLists: [],
            taskCapacity: 64,
            currentEncoder: null,
            frameIndex: 0,
            droppedTaskCount: 0,
            inFlight: 0,
            skipFrame: false,
            disposed: false,
        };
        const restore = installGpuTaskTimer(timer, engine, () => undefined);
        expect(engine._gpuTimerResolve).toBe(engine._gpuTaskTimerResolve);

        const laterFg = createFrameGraph(engine);
        const originalExecute = laterFg.execute;
        const laterSurface = { _renderingContexts: [] as RenderingContext[] };
        engine._surfaces.push(laterSurface as unknown as EngineContext["_surfaces"][number]);
        laterSurface._renderingContexts.push({ frameGraph: laterFg } as RenderingContext & { frameGraph: typeof laterFg });

        expect(laterFg.execute).not.toBe(originalExecute);
        restore();
        expect(laterFg.execute).toBe(originalExecute);
        expect(engine._gpuTimerResolve).toBeUndefined();
        expect(engine._gpuTaskTimerResolve).toBeUndefined();
    });

    it("destroys query, resolve, pooled, and pending readback resources on restore", () => {
        const engine = makeEngineWithFeatures(["timestamp-query"]);
        const surfaces = [] as unknown as EngineContext["_surfaces"];
        Object.assign(engine, { surfaces, _surfaces: surfaces });
        const querySetDestroy = vi.fn();
        const resolveBufferDestroy = vi.fn();
        const pooledReadbackDestroy = vi.fn();
        const pendingReadbackDestroy = vi.fn();
        const pendingReadback = { destroy: pendingReadbackDestroy } as unknown as GPUBuffer;
        const timer: GpuTaskTimer = {
            device: {} as GPUDevice,
            querySet: { destroy: querySetDestroy } as unknown as GPUQuerySet,
            resolveBuffer: { destroy: resolveBufferDestroy } as unknown as GPUBuffer,
            readbackPool: [{ destroy: pooledReadbackDestroy } as unknown as GPUBuffer],
            pendingReadbacks: new Set([pendingReadback]),
            records: [],
            wrappedGraphs: [],
            patchedContextLists: [],
            patchedSurfaceLists: [],
            taskCapacity: 64,
            currentEncoder: null,
            frameIndex: 0,
            droppedTaskCount: 0,
            inFlight: 1,
            skipFrame: false,
            disposed: false,
        };
        const restore = installGpuTaskTimer(timer, engine, () => undefined);

        restore();
        restore();

        expect(querySetDestroy).toHaveBeenCalledOnce();
        expect(resolveBufferDestroy).toHaveBeenCalledOnce();
        expect(pooledReadbackDestroy).toHaveBeenCalledOnce();
        expect(pendingReadbackDestroy).toHaveBeenCalledOnce();
        expect(timer.readbackPool).toEqual([]);
        expect(timer.pendingReadbacks.size).toBe(0);
        expect(timer.inFlight).toBe(0);
        expect(timer.disposed).toBe(true);
    });

    it.each(["resolve", "reject"] as const)("does not publish a readback whose mapAsync %s after restore", async (outcome) => {
        const engine = makeEngineWithFeatures(["timestamp-query"]);
        engine._currentEncoder = {
            beginComputePass: () => ({ end: () => undefined }) as unknown as GPUComputePassEncoder,
        } as unknown as GPUCommandEncoder;
        const fg = createFrameGraph(engine);
        fg._tasks.push(makeTask(engine, "late-task", 1, [], true));
        const surface = { _renderingContexts: [{ frameGraph: fg }] };
        Object.assign(engine, { surfaces: [surface], _surfaces: [surface] });

        let settleMap!: () => void;
        const mapAsync = vi.fn(
            () =>
                new Promise<void>((resolve, reject) => {
                    settleMap = outcome === "resolve" ? resolve : () => reject(new Error("buffer destroyed"));
                })
        );
        const readbackDestroy = vi.fn();
        const readbackUnmap = vi.fn();
        const readback = {
            mapAsync,
            getMappedRange: () => new BigUint64Array([0n, 1_000_000n]).buffer,
            unmap: readbackUnmap,
            destroy: readbackDestroy,
        } as unknown as GPUBuffer;
        const timer: GpuTaskTimer = {
            device: {
                createCommandEncoder: () =>
                    ({
                        resolveQuerySet: () => undefined,
                        copyBufferToBuffer: () => undefined,
                        finish: () => ({}) as GPUCommandBuffer,
                    }) as unknown as GPUCommandEncoder,
                queue: { submit: () => undefined },
            } as unknown as GPUDevice,
            querySet: { destroy: () => undefined } as unknown as GPUQuerySet,
            resolveBuffer: { destroy: () => undefined } as unknown as GPUBuffer,
            readbackPool: [readback],
            pendingReadbacks: new Set(),
            records: [],
            wrappedGraphs: [],
            patchedContextLists: [],
            patchedSurfaceLists: [],
            taskCapacity: 64,
            currentEncoder: null,
            frameIndex: 0,
            droppedTaskCount: 0,
            inFlight: 0,
            skipFrame: false,
            disposed: false,
        };
        const snapshots: unknown[] = [];
        const restore = installGpuTaskTimer(timer, engine, (snapshot) => snapshots.push(snapshot));

        fg.execute();
        engine._gpuTimerResolve?.();
        await Promise.resolve();

        expect(mapAsync).toHaveBeenCalledOnce();
        expect(timer.pendingReadbacks.has(readback)).toBe(true);

        restore();
        settleMap();
        await Promise.resolve();
        await Promise.resolve();

        expect(readbackDestroy).toHaveBeenCalledOnce();
        expect(readbackUnmap).not.toHaveBeenCalled();
        expect(snapshots).toEqual([]);
    });
});
