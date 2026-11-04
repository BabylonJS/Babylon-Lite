import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { disposeGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import { buildRenderTarget, createRenderTarget, disposeRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { createFrameGraph, getFrameGraphTasks } from "../../../packages/babylon-lite/src/frame-graph/frame-graph";
import { addTask, addTaskAfter, addTaskAtStart, addTaskBefore, removeTask } from "../../../packages/babylon-lite/src/frame-graph/frame-graph-actions";
import { createFrameGraphContext, disposeFrameGraphContext } from "../../../packages/babylon-lite/src/frame-graph/frame-graph-context";
import type { Task } from "../../../packages/babylon-lite/src/frame-graph/task";
import { createBloomPostProcessTask } from "../../../packages/babylon-lite/src/post-process/bloom";
import { createSceneContext, disposeScene, getFrameGraph, registerSceneWithShadowSupport } from "../../../packages/babylon-lite/src/scene/scene-core";

function makeEngine(): EngineContext {
    const engine = {
        _device: {
            createBuffer: vi.fn(() => ({ destroy: vi.fn() }) as unknown as GPUBuffer),
            createTexture: vi.fn(() => ({ createView: () => ({}) as GPUTextureView, destroy: vi.fn() }) as unknown as GPUTexture),
            createBindGroupLayout: vi.fn(() => ({}) as GPUBindGroupLayout),
            createBindGroup: vi.fn(() => ({}) as GPUBindGroup),
            createPipelineLayout: vi.fn(() => ({}) as GPUPipelineLayout),
            createShaderModule: vi.fn(() => ({}) as GPUShaderModule),
            createRenderPipeline: vi.fn(() => ({}) as GPURenderPipeline),
            createSampler: vi.fn(() => ({}) as GPUSampler),
            queue: { writeBuffer: vi.fn() },
        },
        canvas: { width: 64, height: 32 },
        msaaSamples: 1,
        format: "bgra8unorm",
        _renderingContexts: [],
        scRT: createRenderTarget({ format: "bgra8unorm", samples: 1, size: { width: 64, height: 32 } }),
    } as unknown as EngineContext;
    Object.assign(engine, { engine });
    Object.assign(engine.scRT, { _eager: true, _colorView: {}, _width: 64, _height: 32 });
    return engine;
}

function makeTask(name: string, engine: EngineContext, executions: string[] = []): Task {
    return {
        name,
        engine,
        _passes: [],
        record: vi.fn(),
        execute: vi.fn(() => {
            executions.push(name);
            return 1;
        }),
        dispose: vi.fn(),
    };
}

describe("FrameGraph task discovery", () => {
    it("lists every appended task in build/execution order without allocating a snapshot", () => {
        const engine = makeEngine();
        const graph = createFrameGraph(engine);
        const tasks = getFrameGraphTasks(graph);
        expect(tasks).toEqual([]);
        expect(getFrameGraphTasks(graph)).toBe(tasks);
        const executions: string[] = [];
        const registered = ["first", "second", "third"].map((name) => makeTask(name, engine, executions));

        for (const task of registered) {
            addTask(graph, task);
            expect(getFrameGraphTasks(graph)).toBe(tasks);
        }
        expect(tasks).toEqual(registered);
        graph.build();
        for (const task of tasks) {
            expect(task.record).toHaveBeenCalledOnce();
        }
        const recordOrder = registered.map((task) => vi.mocked(task.record).mock.invocationCallOrder[0]);
        expect(recordOrder).toEqual([...recordOrder].sort((a, b) => a! - b!));
        expect(graph.execute()).toBe(3);
        expect(executions).toEqual(tasks.map((task) => task.name));
        graph.dispose();
        expect(getFrameGraphTasks(graph)).toBe(tasks);
        expect(tasks).toHaveLength(0);
        for (const task of registered) {
            expect(task.dispose).toHaveBeenCalledOnce();
        }
    });

    it("keeps the same live list through start/before/after insertion and duplicate removal", () => {
        const engine = makeEngine();
        const graph = createFrameGraph(engine);
        const tasks = getFrameGraphTasks(graph);
        const executions: string[] = [];
        const middle = makeTask("middle", engine, executions);
        const start = makeTask("start", engine, executions);
        const before = makeTask("before", engine, executions);
        const after = makeTask("after", engine, executions);
        addTask(graph, middle);
        expect(tasks).toEqual([middle]);
        addTaskAtStart(graph, start);
        expect(getFrameGraphTasks(graph)).toBe(tasks);
        expect(tasks).toEqual([start, middle]);
        addTaskBefore(graph, before, middle);
        expect(getFrameGraphTasks(graph)).toBe(tasks);
        expect(tasks).toEqual([start, before, middle]);
        addTaskAfter(graph, after, middle);
        expect(getFrameGraphTasks(graph)).toBe(tasks);
        expect(tasks).toEqual([start, before, middle, after]);
        addTask(graph, middle);
        expect(tasks).toEqual([start, before, middle, after, middle]);

        expect(removeTask(graph, middle)).toBe(true);
        expect(getFrameGraphTasks(graph)).toBe(tasks);
        expect(tasks).toEqual([start, before, after]);
        expect(middle.dispose).not.toHaveBeenCalled();
        expect(graph.execute()).toBe(3);
        expect(executions).toEqual(["start", "before", "after"]);
        graph.dispose();
        expect(middle.dispose).not.toHaveBeenCalled();
        middle.dispose();
    });

    it("discovers the default scene render and system shadow task before user work", async () => {
        const engine = makeEngine();
        const scene = createSceneContext(engine);
        const graph = getFrameGraph(scene);
        const tasks = getFrameGraphTasks(graph);
        expect(tasks.map((task) => task.name)).toEqual(["scene"]);
        expect(tasks[0]!.scene).toBe(scene);
        const first = makeTask("first", engine);
        const last = makeTask("last", engine);
        addTask(scene, first);
        addTask(scene, last);
        expect(getFrameGraphTasks(graph)).toBe(tasks);
        expect(tasks.map((task) => task.name)).toEqual(["scene", "first", "last"]);
        try {
            await registerSceneWithShadowSupport(scene);
            expect(getFrameGraphTasks(graph)).toBe(tasks);
            expect(tasks.map((task) => task.name)).toEqual(["shadow", "scene", "first", "last"]);
            expect(tasks[0]!.scene).toBe(scene);

            const start = makeTask("start", engine);
            const before = makeTask("before", engine);
            const after = makeTask("after", engine);
            addTaskAtStart(scene, start);
            addTaskBefore(scene, before, first);
            addTaskAfter(scene, after, first);
            expect(getFrameGraphTasks(graph)).toBe(tasks);
            expect(tasks.map((task) => task.name)).toEqual(["shadow", "start", "scene", "before", "first", "after", "last"]);
            expect(removeTask(scene, first)).toBe(true);
            expect(getFrameGraphTasks(graph)).toBe(tasks);
            expect(tasks.map((task) => task.name)).toEqual(["shadow", "start", "scene", "before", "after", "last"]);
        } finally {
            disposeScene(scene);
            disposeGpuResourceRetirements(engine);
        }
        expect(getFrameGraphTasks(graph)).toBe(tasks);
        expect(tasks).toHaveLength(0);
    });

    it("includes disabled tasks and treats an absent execution gate as enabled", () => {
        const engine = makeEngine();
        const graph = createFrameGraph(engine);
        const executions: string[] = [];
        const implicit = makeTask("implicit", engine, executions);
        const enabled = makeTask("enabled", engine, executions);
        const disabled = makeTask("disabled", engine, executions);
        enabled.executionEnabled = true;
        disabled.executionEnabled = false;
        for (const task of [implicit, enabled, disabled]) {
            addTask(graph, task);
        }
        const tasks = getFrameGraphTasks(graph);
        graph.build();
        expect(tasks).toEqual([implicit, enabled, disabled]);
        expect(disabled.record).toHaveBeenCalledOnce();
        expect(graph.execute()).toBe(2);
        expect(executions).toEqual(["implicit", "enabled"]);
        expect(disabled.execute).not.toHaveBeenCalled();
        disabled.executionEnabled = true;
        expect(getFrameGraphTasks(graph)).toBe(tasks);
        expect(graph.execute()).toBe(3);
        graph.dispose();
    });

    it("lists a real bloom composite once without its privately owned sub-tasks", () => {
        const engine = makeEngine();
        const graph = createFrameGraph(engine);
        const source = createRenderTarget({ format: "rgba8unorm", samples: 1, size: { width: 64, height: 32 } });
        buildRenderTarget(source, engine);
        const bloom = createBloomPostProcessTask({ sourceTexture: source }, engine);
        const before = makeTask("before", engine);
        const after = makeTask("after", engine);
        addTask(graph, before);
        addTask(graph, bloom);
        addTask(graph, after);

        const tasks = getFrameGraphTasks(graph);
        graph.build();
        expect(getFrameGraphTasks(graph)).toBe(tasks);
        expect(tasks).toEqual([before, bloom, after]);
        expect(tasks.filter((task) => task === bloom)).toHaveLength(1);
        expect(tasks.map((task) => task.name)).toEqual(["before", "bloom", "after"]);
        graph.dispose();
        disposeRenderTarget(source);
    });

    it("enumerates a standalone context and empties the same list on disposal", () => {
        const engine = makeEngine();
        const context = createFrameGraphContext(engine);
        const tasks = getFrameGraphTasks(context.frameGraph);
        const task = makeTask("standalone", engine);
        expect(tasks).toHaveLength(0);
        addTask(context.frameGraph, task);
        expect(getFrameGraphTasks(context.frameGraph)).toBe(tasks);
        expect(tasks).toEqual([task]);
        expect(task.scene).toBeUndefined();

        disposeFrameGraphContext(context);
        expect(getFrameGraphTasks(context.frameGraph)).toBe(tasks);
        expect(tasks).toHaveLength(0);
        expect(task.dispose).toHaveBeenCalledOnce();
    });
});
