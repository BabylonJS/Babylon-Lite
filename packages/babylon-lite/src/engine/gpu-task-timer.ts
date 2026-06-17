import type { EngineContext, RenderingContext } from "./engine.js";
import type { FrameGraph } from "../frame-graph/frame-graph.js";
import type { Task } from "../frame-graph/task.js";
import type { SurfaceContext } from "./surface.js";
import { makeTimingSnapshot, type RenderTaskGpuTiming, type RenderTaskGpuTimings } from "./gpu-task-timing.js";

const INITIAL_TASK_CAPACITY = 64;
const MAX_IN_FLIGHT_READBACKS = 3;

interface TaskTimingRecord {
    readonly index: number;
    readonly name: string;
    readonly beginQueryIndex: number;
    readonly endQueryIndex: number;
}

interface PendingTaskTimingReadback {
    readonly buffer: GPUBuffer;
    readonly byteLength: number;
    readonly frameIndex: number;
    readonly records: readonly TaskTimingRecord[];
    readonly droppedTaskCount: number;
    readonly publish: (snapshot: RenderTaskGpuTimings) => void;
}

interface WrappedFrameGraph {
    readonly graph: FrameGraph;
    readonly execute: () => number;
}

interface PatchedContextList {
    readonly list: RenderingContext[];
    readonly push: (...items: RenderingContext[]) => number;
}

interface PatchedSurfaceList {
    readonly list: SurfaceContext[];
    readonly push: (...items: SurfaceContext[]) => number;
}

/** @internal GPU resources/state for opt-in per-frame-graph-task timestamp queries. */
export interface GpuTaskTimer {
    readonly device: GPUDevice;
    readonly querySet: GPUQuerySet;
    readonly resolveBuffer: GPUBuffer;
    readonly readbackPool: GPUBuffer[];
    readonly records: TaskTimingRecord[];
    readonly wrappedGraphs: WrappedFrameGraph[];
    readonly patchedContextLists: PatchedContextList[];
    readonly patchedSurfaceLists: PatchedSurfaceList[];
    readonly taskCapacity: number;
    currentEncoder: GPUCommandEncoder | null;
    frameIndex: number;
    droppedTaskCount: number;
    inFlight: number;
    skipFrame: boolean;
}

/** Create the per-task GPU timer, or null when timestamp queries are unsupported. */
export function createGpuTaskTimer(device: GPUDevice): GpuTaskTimer | null {
    if (!device.features.has("timestamp-query")) {
        return null;
    }
    const queryCount = INITIAL_TASK_CAPACITY * 2;
    return {
        device,
        querySet: device.createQuerySet({ type: "timestamp", count: queryCount }),
        resolveBuffer: device.createBuffer({
            size: queryCount * 8,
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        }),
        readbackPool: [],
        records: [],
        wrappedGraphs: [],
        patchedContextLists: [],
        patchedSurfaceLists: [],
        taskCapacity: INITIAL_TASK_CAPACITY,
        currentEncoder: null,
        frameIndex: 0,
        droppedTaskCount: 0,
        inFlight: 0,
        skipFrame: false,
    };
}

/** Install timed frame-graph execute wrappers on all contexts currently registered with the engine. */
export function installGpuTaskTimer(timer: GpuTaskTimer, engine: EngineContext, publish: (snapshot: RenderTaskGpuTimings) => void): () => void {
    patchSurfaceList(timer, engine._surfaces);
    for (const surface of engine.surfaces) {
        patchSurface(timer, surface);
    }
    const previousResolve = engine._gpuTimerResolve;
    const resolveTaskTiming = () => finishTaskTimingFrame(timer, publish);
    const resolveBoth = () => {
        previousResolve?.();
        resolveTaskTiming();
    };
    engine._gpuTaskTimerResolve = resolveTaskTiming;
    engine._gpuTimerResolve = resolveBoth;
    return () => restoreWrappedFrameGraphs(timer, engine, previousResolve, resolveTaskTiming, resolveBoth);
}

function patchSurfaceList(timer: GpuTaskTimer, list: SurfaceContext[]): void {
    for (const patched of timer.patchedSurfaceLists) {
        if (patched.list === list) {
            return;
        }
    }
    const push = list.push;
    list.push = (...items: SurfaceContext[]) => {
        const length = push.apply(list, items);
        for (const surface of items) {
            patchSurface(timer, surface);
        }
        return length;
    };
    timer.patchedSurfaceLists.push({ list, push });
}

function patchSurface(timer: GpuTaskTimer, surface: SurfaceContext): void {
    const contexts = surface._renderingContexts;
    patchContextList(timer, contexts);
    for (const context of contexts) {
        const graph = getFrameGraphFromContext(context);
        if (graph) {
            wrapFrameGraph(timer, graph);
        }
    }
}

function patchContextList(timer: GpuTaskTimer, list: RenderingContext[]): void {
    for (const patched of timer.patchedContextLists) {
        if (patched.list === list) {
            return;
        }
    }
    const push = list.push;
    list.push = (...items: RenderingContext[]) => {
        const length = push.apply(list, items);
        for (const context of items) {
            const graph = getFrameGraphFromContext(context);
            if (graph) {
                wrapFrameGraph(timer, graph);
            }
        }
        return length;
    };
    timer.patchedContextLists.push({ list, push });
}

function wrapFrameGraph(timer: GpuTaskTimer, graph: FrameGraph): void {
    for (const wrapped of timer.wrappedGraphs) {
        if (wrapped.graph === graph) {
            return;
        }
    }
    const original = graph.execute;
    const timed = () => executeTimedFrameGraph(timer, graph);
    graph.execute = timed;
    timer.wrappedGraphs.push({ graph, execute: original });
}

function restoreWrappedFrameGraphs(
    timer: GpuTaskTimer,
    engine: EngineContext,
    previousResolve: (() => void) | undefined,
    resolveTaskTiming: () => void,
    resolveBoth: () => void
): void {
    for (const patched of timer.patchedSurfaceLists) {
        patched.list.push = patched.push;
    }
    timer.patchedSurfaceLists.length = 0;
    for (const patched of timer.patchedContextLists) {
        patched.list.push = patched.push;
    }
    timer.patchedContextLists.length = 0;
    for (const wrapped of timer.wrappedGraphs) {
        wrapped.graph.execute = wrapped.execute;
    }
    timer.wrappedGraphs.length = 0;
    timer.currentEncoder = null;
    if (engine._gpuTaskTimerResolve === resolveTaskTiming) {
        engine._gpuTaskTimerResolve = undefined;
    }
    if (engine._gpuTimerResolve === resolveBoth) {
        engine._gpuTimerResolve = previousResolve;
    } else if (engine._gpuTimerResolve === resolveTaskTiming) {
        engine._gpuTimerResolve = undefined;
    }
}

function getFrameGraphFromContext(context: RenderingContext): FrameGraph | null {
    const owner = context as RenderingContext & { _frameGraph?: unknown; frameGraph?: unknown };
    const graph = owner._frameGraph ?? owner.frameGraph;
    return isFrameGraph(graph) ? graph : null;
}

function isFrameGraph(value: unknown): value is FrameGraph {
    return typeof value === "object" && value !== null && "_tasks" in value && "execute" in value;
}

function executeTimedFrameGraph(timer: GpuTaskTimer, graph: FrameGraph): number {
    let drawCalls = 0;
    for (const task of graph._tasks) {
        drawCalls += gpuTaskTimerExecute(timer, task);
    }
    return drawCalls;
}

/** Execute one frame-graph task bracketed by timestamp writes. */
function gpuTaskTimerExecute(timer: GpuTaskTimer, task: Task): number {
    const encoder = task.engine._currentEncoder;
    if (timer.currentEncoder !== encoder) {
        beginTaskTimingFrame(timer, encoder);
    }
    if (timer.skipFrame) {
        return executeTask(task);
    }

    const measuredCount = timer.records.length;
    const taskIndex = measuredCount + timer.droppedTaskCount;
    if (measuredCount >= timer.taskCapacity) {
        timer.droppedTaskCount++;
        return executeTask(task);
    }
    const beginQueryIndex = measuredCount * 2;
    const endQueryIndex = beginQueryIndex + 1;
    encoder.beginComputePass({ timestampWrites: { querySet: timer.querySet, beginningOfPassWriteIndex: beginQueryIndex } }).end();
    const drawCalls = executeTask(task);
    encoder.beginComputePass({ timestampWrites: { querySet: timer.querySet, endOfPassWriteIndex: endQueryIndex } }).end();
    timer.records.push({ index: taskIndex, name: task.name, beginQueryIndex, endQueryIndex });
    return drawCalls;
}

function executeTask(task: Task): number {
    if (task.execute) {
        return task.execute();
    }
    let drawCalls = 0;
    for (const pass of task._passes) {
        drawCalls += pass._execute();
    }
    return drawCalls;
}

function beginTaskTimingFrame(timer: GpuTaskTimer, encoder: GPUCommandEncoder): void {
    timer.currentEncoder = encoder;
    timer.records.length = 0;
    timer.droppedTaskCount = 0;
    timer.skipFrame = timer.inFlight > MAX_IN_FLIGHT_READBACKS;
}

/** Resolve this frame's task timestamps after renderFrame has submitted the command buffer. */
function finishTaskTimingFrame(timer: GpuTaskTimer, publish: (snapshot: RenderTaskGpuTimings) => void): void {
    timer.frameIndex++;
    const taskCount = timer.records.length;
    if (timer.skipFrame || taskCount === 0 || timer.inFlight > MAX_IN_FLIGHT_READBACKS) {
        return;
    }

    const queryCount = taskCount * 2;
    const byteLength = queryCount * 8;
    const readback = timer.readbackPool.pop() ?? createReadbackBuffer(timer);
    const encoder = timer.device.createCommandEncoder({ label: "gpu-task-timing-resolve" });
    encoder.resolveQuerySet(timer.querySet, 0, queryCount, timer.resolveBuffer, 0);
    encoder.copyBufferToBuffer(timer.resolveBuffer, 0, readback, 0, byteLength);
    timer.device.queue.submit([encoder.finish()]);
    timer.inFlight++;
    void finishTaskTimingReadback(timer, {
        buffer: readback,
        byteLength,
        frameIndex: timer.frameIndex,
        records: timer.records.slice(),
        droppedTaskCount: timer.droppedTaskCount,
        publish,
    });
}

function createReadbackBuffer(timer: GpuTaskTimer): GPUBuffer {
    return timer.device.createBuffer({
        size: timer.taskCapacity * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
}

async function finishTaskTimingReadback(timer: GpuTaskTimer, pending: PendingTaskTimingReadback): Promise<void> {
    const buffer = pending.buffer;
    try {
        // Let the resolve/copy submit leave the JavaScript stack before mapping.
        await Promise.resolve();
        await buffer.mapAsync(GPUMapMode.READ, 0, pending.byteLength);
        const raw = new BigUint64Array(buffer.getMappedRange(0, pending.byteLength));
        const tasks: RenderTaskGpuTiming[] = [];
        for (const record of pending.records) {
            const begin = raw[record.beginQueryIndex]!;
            const end = raw[record.endQueryIndex]!;
            if (end >= begin) {
                tasks.push({ index: record.index, name: record.name, durationMs: Number(end - begin) / 1e6 });
            }
        }
        buffer.unmap();
        timer.readbackPool.push(buffer);
        timer.inFlight--;
        pending.publish(makeTimingSnapshot("available", true, true, pending.frameIndex, tasks, pending.droppedTaskCount));
    } catch (error) {
        timer.inFlight--;
        buffer.destroy();
        pending.publish(makeTimingSnapshot("error", true, true, pending.frameIndex, [], pending.droppedTaskCount, readbackErrorMessage(error)));
    }
}

function readbackErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
