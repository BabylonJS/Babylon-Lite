import type { EngineContext, RenderingContext } from "./engine.js";
import type { FrameGraph } from "../frame-graph/frame-graph.js";
import type { Task } from "../frame-graph/task.js";
import type { SurfaceContext } from "./surface.js";
import { addFramePostSubmitHook } from "./frame-post-submit.js";
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

interface ActiveTaskTiming {
    beginQueryIndex: number;
    endQueryIndex: number;
    passCount: number;
    conflicted: boolean;
    dropped: boolean;
}

interface PatchedEncoderMethods {
    readonly encoder: GPUCommandEncoder;
    readonly beginRenderPass: PropertyDescriptor | undefined;
    readonly beginComputePass: PropertyDescriptor | undefined;
}

/** @internal GPU resources/state for opt-in per-frame-graph-task timestamp queries. */
export interface GpuTaskTimer {
    readonly device: GPUDevice;
    readonly querySet: GPUQuerySet;
    readonly resolveBuffer: GPUBuffer;
    readonly readbackPool: GPUBuffer[];
    readonly pendingReadbacks: Set<GPUBuffer>;
    readonly records: TaskTimingRecord[];
    readonly wrappedGraphs: WrappedFrameGraph[];
    readonly patchedContextLists: PatchedContextList[];
    readonly patchedSurfaceLists: PatchedSurfaceList[];
    readonly taskCapacity: number;
    currentEncoder: GPUCommandEncoder | null;
    patchedEncoderMethods: PatchedEncoderMethods | null;
    activeTaskTiming: ActiveTaskTiming | null;
    nextQueryIndex: number;
    nextTaskIndex: number;
    frameIndex: number;
    lastPublishedFrameIndex: number;
    droppedTaskCount: number;
    inFlight: number;
    skipFrame: boolean;
    disposed: boolean;
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
        pendingReadbacks: new Set(),
        records: [],
        wrappedGraphs: [],
        patchedContextLists: [],
        patchedSurfaceLists: [],
        taskCapacity: INITIAL_TASK_CAPACITY,
        currentEncoder: null,
        patchedEncoderMethods: null,
        activeTaskTiming: null,
        nextQueryIndex: 0,
        nextTaskIndex: 0,
        frameIndex: 0,
        lastPublishedFrameIndex: 0,
        droppedTaskCount: 0,
        inFlight: 0,
        skipFrame: false,
        disposed: false,
    };
}

/** Install timed frame-graph execute wrappers on all contexts currently registered with the engine. */
export function installGpuTaskTimer(timer: GpuTaskTimer, engine: EngineContext, publish: (snapshot: RenderTaskGpuTimings) => void): () => void {
    patchSurfaceList(timer, engine._surfaces);
    for (const surface of engine.surfaces) {
        patchSurface(timer, surface);
    }
    const resolveTaskTiming = (encoder: GPUCommandEncoder) => {
        if (timer.currentEncoder === encoder) {
            finishTaskTimingFrame(timer, publish);
        }
    };
    const removePostSubmit = addFramePostSubmitHook(engine, "persistent", resolveTaskTiming);
    return () => {
        restoreWrappedFrameGraphs(timer, removePostSubmit);
        disposeGpuTaskTimer(timer);
    };
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

function restoreWrappedFrameGraphs(timer: GpuTaskTimer, removePostSubmit: () => void): void {
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
    restoreTimingEncoder(timer);
    removePostSubmit();
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
        if (task.executionEnabled === false) {
            continue;
        }
        drawCalls += gpuTaskTimerExecute(timer, task);
    }
    return drawCalls;
}

/** Execute one frame-graph task with timestamps attached to its real GPU passes. */
function gpuTaskTimerExecute(timer: GpuTaskTimer, task: Task): number {
    const engine = task.engine;
    const encoder = engine._currentEncoder;
    if (timer.currentEncoder !== encoder) {
        beginTaskTimingFrame(timer, encoder);
    }
    const taskIndex = timer.nextTaskIndex++;
    if (timer.skipFrame) {
        return executeTask(task);
    }

    const timing: ActiveTaskTiming = { beginQueryIndex: -1, endQueryIndex: -1, passCount: 0, conflicted: false, dropped: false };
    timer.activeTaskTiming = timing;
    try {
        const drawCalls = executeTask(task);
        if (timing.passCount > 0 && !timing.conflicted && !timing.dropped) {
            timer.records.push({ index: taskIndex, name: task.name, beginQueryIndex: timing.beginQueryIndex, endQueryIndex: timing.endQueryIndex });
        }
        return drawCalls;
    } finally {
        timer.activeTaskTiming = null;
    }
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
    restoreTimingEncoder(timer);
    timer.currentEncoder = encoder;
    timer.patchedEncoderMethods = patchTimingEncoder(timer, encoder);
    timer.records.length = 0;
    timer.nextQueryIndex = 0;
    timer.nextTaskIndex = 0;
    timer.droppedTaskCount = 0;
    timer.skipFrame = timer.inFlight > MAX_IN_FLIGHT_READBACKS;
}

function patchTimingEncoder(timer: GpuTaskTimer, encoder: GPUCommandEncoder): PatchedEncoderMethods {
    const beginRenderPass = encoder.beginRenderPass.bind(encoder);
    const beginComputePass = encoder.beginComputePass.bind(encoder);
    const renderDescriptor = Object.getOwnPropertyDescriptor(encoder, "beginRenderPass");
    const computeDescriptor = Object.getOwnPropertyDescriptor(encoder, "beginComputePass");
    if (!Reflect.set(encoder, "beginRenderPass", (descriptor: GPURenderPassDescriptor) => beginRenderPass(withTaskTimestamps(timer, descriptor)), encoder)) {
        throw new Error("GPU task timing could not instrument render passes on this command encoder.");
    }
    if (!Reflect.set(encoder, "beginComputePass", (descriptor?: GPUComputePassDescriptor) => beginComputePass(withTaskTimestamps(timer, descriptor)), encoder)) {
        restoreEncoderMethod(encoder, "beginRenderPass", renderDescriptor);
        throw new Error("GPU task timing could not instrument compute passes on this command encoder.");
    }
    return { encoder, beginRenderPass: renderDescriptor, beginComputePass: computeDescriptor };
}

function withTaskTimestamps<T extends GPURenderPassDescriptor | GPUComputePassDescriptor | undefined>(timer: GpuTaskTimer, descriptor: T): T {
    const timing = timer.activeTaskTiming;
    if (!timing || timing.conflicted || timing.dropped) {
        return descriptor;
    }
    if (descriptor?.timestampWrites !== undefined) {
        timing.conflicted = true;
        return descriptor;
    }
    const queryCapacity = timer.taskCapacity * 2;
    if (timing.passCount === 0) {
        if (timer.nextQueryIndex + 2 > queryCapacity) {
            timing.dropped = true;
            timer.droppedTaskCount++;
            return descriptor;
        }
        timing.beginQueryIndex = timer.nextQueryIndex++;
        timing.endQueryIndex = timer.nextQueryIndex++;
        timing.passCount++;
        return {
            ...descriptor,
            timestampWrites: {
                querySet: timer.querySet,
                beginningOfPassWriteIndex: timing.beginQueryIndex,
                endOfPassWriteIndex: timing.endQueryIndex,
            },
        } as T;
    }
    if (timer.nextQueryIndex >= queryCapacity) {
        timing.dropped = true;
        timer.droppedTaskCount++;
        return descriptor;
    }
    timing.endQueryIndex = timer.nextQueryIndex++;
    timing.passCount++;
    const timestampWrites: NonNullable<GPUComputePassDescriptor["timestampWrites"]> = {
        querySet: timer.querySet,
        endOfPassWriteIndex: timing.endQueryIndex,
    };
    return { ...descriptor, timestampWrites } as T;
}

function restoreTimingEncoder(timer: GpuTaskTimer): void {
    const patched = timer.patchedEncoderMethods;
    if (patched) {
        restoreEncoderMethod(patched.encoder, "beginRenderPass", patched.beginRenderPass);
        restoreEncoderMethod(patched.encoder, "beginComputePass", patched.beginComputePass);
    }
    timer.currentEncoder = null;
    timer.patchedEncoderMethods = null;
    timer.activeTaskTiming = null;
}

function restoreEncoderMethod(encoder: GPUCommandEncoder, property: "beginRenderPass" | "beginComputePass", descriptor: PropertyDescriptor | undefined): void {
    if (descriptor) {
        Object.defineProperty(encoder, property, descriptor);
    } else {
        Reflect.deleteProperty(encoder, property);
    }
}

/** Resolve this frame's task timestamps after renderFrame has submitted the command buffer. */
function finishTaskTimingFrame(timer: GpuTaskTimer, publish: (snapshot: RenderTaskGpuTimings) => void): void {
    if (timer.disposed) {
        return;
    }
    timer.frameIndex++;
    const records = timer.records.slice();
    const taskCount = records.length;
    const queryCount = timer.nextQueryIndex;
    const droppedTaskCount = timer.droppedTaskCount;
    timer.records.length = 0;
    timer.nextQueryIndex = 0;
    timer.droppedTaskCount = 0;
    restoreTimingEncoder(timer);
    if (timer.skipFrame || timer.inFlight > MAX_IN_FLIGHT_READBACKS) {
        return;
    }
    if (taskCount === 0) {
        if (droppedTaskCount > 0) {
            publishTaskTimingSnapshot(timer, publish, makeTimingSnapshot("available", true, true, timer.frameIndex, [], droppedTaskCount, 0));
        }
        return;
    }

    const byteLength = queryCount * 8;
    const readback = timer.readbackPool.pop() ?? createReadbackBuffer(timer);
    const encoder = timer.device.createCommandEncoder({ label: "gpu-task-timing-resolve" });
    encoder.resolveQuerySet(timer.querySet, 0, queryCount, timer.resolveBuffer, 0);
    encoder.copyBufferToBuffer(timer.resolveBuffer, 0, readback, 0, byteLength);
    timer.device.queue.submit([encoder.finish()]);
    timer.inFlight++;
    timer.pendingReadbacks.add(readback);
    void finishTaskTimingReadback(timer, {
        buffer: readback,
        byteLength,
        frameIndex: timer.frameIndex,
        records,
        droppedTaskCount,
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
        if (timer.disposed) {
            return;
        }
        const raw = new BigUint64Array(buffer.getMappedRange(0, pending.byteLength));
        const tasks: RenderTaskGpuTiming[] = [];
        let earliestBegin: bigint | null = null;
        let latestEnd: bigint | null = null;
        for (const record of pending.records) {
            const begin = raw[record.beginQueryIndex]!;
            const end = raw[record.endQueryIndex]!;
            if (end >= begin) {
                tasks.push({ index: record.index, name: record.name, durationMs: Number(end - begin) / 1e6 });
                earliestBegin = earliestBegin === null || begin < earliestBegin ? begin : earliestBegin;
                latestEnd = latestEnd === null || end > latestEnd ? end : latestEnd;
            }
        }
        const totalDurationMs = earliestBegin === null || latestEnd === null ? 0 : Number(latestEnd - earliestBegin) / 1e6;
        buffer.unmap();
        timer.pendingReadbacks.delete(buffer);
        timer.readbackPool.push(buffer);
        timer.inFlight--;
        publishTaskTimingSnapshot(timer, pending.publish, makeTimingSnapshot("available", true, true, pending.frameIndex, tasks, pending.droppedTaskCount, totalDurationMs));
    } catch (error) {
        if (timer.disposed) {
            return;
        }
        timer.pendingReadbacks.delete(buffer);
        timer.inFlight--;
        buffer.destroy();
        publishTaskTimingSnapshot(
            timer,
            pending.publish,
            makeTimingSnapshot("error", true, true, pending.frameIndex, [], pending.droppedTaskCount, 0, readbackErrorMessage(error))
        );
    }
}

function publishTaskTimingSnapshot(timer: GpuTaskTimer, publish: (snapshot: RenderTaskGpuTimings) => void, snapshot: RenderTaskGpuTimings): void {
    if (snapshot.frameIndex > timer.lastPublishedFrameIndex) {
        timer.lastPublishedFrameIndex = snapshot.frameIndex;
        publish(snapshot);
    }
}

function disposeGpuTaskTimer(timer: GpuTaskTimer): void {
    if (timer.disposed) {
        return;
    }
    timer.disposed = true;
    timer.querySet.destroy();
    timer.resolveBuffer.destroy();
    for (const buffer of timer.readbackPool) {
        buffer.destroy();
    }
    for (const buffer of timer.pendingReadbacks) {
        buffer.destroy();
    }
    timer.readbackPool.length = 0;
    timer.pendingReadbacks.clear();
    timer.inFlight = 0;
}

function readbackErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
