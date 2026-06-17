import { describe, expect, it } from "vitest";

import type { EngineContext, RenderingContext } from "../../../packages/babylon-lite/src/engine/engine";
import { getRenderTaskGpuTimings, isRenderTaskGpuTimingSupported, setRenderTaskGpuTimingEnabled } from "../../../packages/babylon-lite/src/engine/gpu-task-timing";
import { installGpuTaskTimer, type GpuTaskTimer } from "../../../packages/babylon-lite/src/engine/gpu-task-timer";
import { createFrameGraph } from "../../../packages/babylon-lite/src/frame-graph/frame-graph";
import type { Pass } from "../../../packages/babylon-lite/src/frame-graph/pass";
import type { Task } from "../../../packages/babylon-lite/src/frame-graph/task";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUMapMode"> & { GPUMapMode?: { READ: number; WRITE: number } };
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
        fg._tasks.push(makeTask(engine, "task-execute", 2, log, true), makeTask(engine, "pass-execute", 3, log, false));
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
            querySet: {} as GPUQuerySet,
            resolveBuffer: {} as GPUBuffer,
            readbackPool: [readback],
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
        };
        const snapshots: unknown[] = [];
        let previousResolveCalls = 0;
        const previousResolve = () => {
            previousResolveCalls++;
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
            querySet: {} as GPUQuerySet,
            resolveBuffer: {} as GPUBuffer,
            readbackPool: [],
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
        };
        const restore = installGpuTaskTimer(timer, engine, () => undefined);

        const laterFg = createFrameGraph(engine);
        const originalExecute = laterFg.execute;
        const laterSurface = { _renderingContexts: [] as RenderingContext[] };
        engine._surfaces.push(laterSurface as unknown as EngineContext["_surfaces"][number]);
        laterSurface._renderingContexts.push({ frameGraph: laterFg } as RenderingContext & { frameGraph: typeof laterFg });

        expect(laterFg.execute).not.toBe(originalExecute);
        restore();
        expect(laterFg.execute).toBe(originalExecute);
        expect(engine._gpuTimerResolve).toBeUndefined();
    });
});
