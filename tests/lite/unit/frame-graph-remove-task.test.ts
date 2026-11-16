import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { addTask, addTaskBefore, removeTask } from "../../../packages/babylon-lite/src/frame-graph/frame-graph-actions";
import { buildFrameGraphTask, createFrameGraph } from "../../../packages/babylon-lite/src/frame-graph/frame-graph";
import { registerFrameGraphContextAsync } from "../../../packages/babylon-lite/src/frame-graph/frame-graph-context";
import type { FrameGraphContext } from "../../../packages/babylon-lite/src/frame-graph/frame-graph-context";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Task } from "../../../packages/babylon-lite/src/frame-graph/task";

function makeTask(name: string, executions: string[], direct = false): Task {
    const task: Task = {
        name,
        engine: {} as EngineContext,
        _passes: [],
        record: vi.fn(() => {
            if (!direct) {
                task._passes.push({
                    name: `${name}-pass`,
                    _parentTask: task,
                    _dependencies: new Set(),
                    _executeFunc: null,
                    _beforeExecute: null,
                    _initialize: vi.fn(),
                    _execute: vi.fn(() => {
                        executions.push(name);
                        return 1;
                    }),
                    _dispose: vi.fn(),
                });
            }
        }),
        dispose: vi.fn(() => {
            for (const pass of task._passes) {
                pass._dispose();
            }
            task._passes.length = 0;
        }),
    };
    if (direct) {
        task.execute = vi.fn(() => {
            executions.push(name);
            return 1;
        });
    }
    return task;
}

describe("FrameGraph task removal", () => {
    it.each([false, true])("stops future builds and execution while preserving task ownership (direct: %s)", (direct) => {
        const graph = createFrameGraph({} as EngineContext);
        const executions: string[] = [];
        const first = makeTask("first", executions);
        const removed = makeTask("removed", executions, direct);
        const last = makeTask("last", executions);
        for (const task of [first, removed, last]) {
            addTask(graph, task);
        }
        graph.build();
        const recorded = removed._passes.slice();

        expect(removeTask(graph, removed)).toBe(true);
        expect(graph.execute()).toBe(2);
        expect(executions).toEqual(["first", "last"]);
        expect(removed._passes).toEqual(recorded);
        expect(removed.dispose).not.toHaveBeenCalled();
        graph.build();
        expect(removed.record).toHaveBeenCalledOnce();
        for (const pass of recorded) {
            expect(pass._initialize).toHaveBeenCalledOnce();
        }
        graph.dispose();
        expect(first.dispose).toHaveBeenCalledOnce();
        expect(last.dispose).toHaveBeenCalledOnce();
        expect(removed.dispose).not.toHaveBeenCalled();
        expect(removed._passes).toEqual(recorded);
        for (const pass of recorded) {
            expect(pass._dispose).not.toHaveBeenCalled();
        }
        removed.dispose();
    });

    it.each(["graph", "scene"] as const)("removes duplicate identities in place and leaves same-named tasks intact through a %s", (targetKind) => {
        const graph = createFrameGraph({} as EngineContext);
        const target = targetKind === "graph" ? graph : ({ _frameGraph: graph } as SceneContext);
        const first = makeTask("first", []);
        const removed = makeTask("effect", []);
        const sameName = makeTask("effect", []);
        const last = makeTask("last", []);
        const original = [first, removed, sameName, removed, last, removed];
        for (const task of original) {
            addTask(target, task);
        }
        const tasks = graph._tasks;

        expect(removeTask(target, makeTask("effect", []))).toBe(false);
        expect(tasks).toEqual(original);
        expect(removeTask(target, removed)).toBe(true);
        expect(graph._tasks).toBe(tasks);
        expect(tasks).toEqual([first, sameName, last]);
        expect(removeTask(target, removed)).toBe(false);
        expect(tasks).toEqual([first, sameName, last]);
    });

    it("does not record or take disposal ownership of a task removed before the first build", () => {
        const graph = createFrameGraph({} as EngineContext);
        const task = makeTask("unbuilt", []);
        addTask(graph, task);
        removeTask(graph, task);

        graph.build();
        expect(graph.execute()).toBe(0);
        graph.dispose();
        expect(task.record).not.toHaveBeenCalled();
        expect(task.dispose).not.toHaveBeenCalled();
    });

    it("does not change membership in another graph", () => {
        const graph = createFrameGraph({} as EngineContext);
        const other = createFrameGraph({} as EngineContext);
        const executions: string[] = [];
        const task = makeTask("ownedElsewhere", executions, true);
        addTask(other, task);
        other.build();

        expect(removeTask(graph, task)).toBe(false);
        expect(other.execute()).toBe(1);
        expect(executions).toEqual(["ownedElsewhere"]);
        other.dispose();
    });

    it("reuses recorded state after re-addition and restores graph disposal ownership", () => {
        const graph = createFrameGraph({} as EngineContext);
        const executions: string[] = [];
        const first = makeTask("first", executions);
        const task = makeTask("reused", executions);
        const last = makeTask("last", executions);
        for (const current of [first, task, last]) {
            addTask(graph, current);
        }
        graph.build();
        const pass = task._passes[0]!;
        removeTask(graph, task);
        expect(() => buildFrameGraphTask(graph, task)).toThrow(/not registered/);
        addTaskBefore(graph, task, last);

        expect(graph.execute()).toBe(3);
        expect(executions).toEqual(["first", "reused", "last"]);
        expect(task._passes[0]).toBe(pass);
        expect(task.record).toHaveBeenCalledOnce();
        buildFrameGraphTask(graph, task);
        expect(task.record).toHaveBeenCalledTimes(2);
        expect(first.record).toHaveBeenCalledOnce();
        expect(last.record).toHaveBeenCalledOnce();
        graph.dispose();
        expect(task.dispose).toHaveBeenCalledOnce();
    });

    it("keeps a task removed during async preload out of the later build", async () => {
        const engine = {} as EngineContext;
        const graph = createFrameGraph(engine);
        const task = makeTask("preloading", []);
        let finishPreload!: () => void;
        task._preload = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finishPreload = resolve;
                })
        );
        addTask(graph, task);
        const surface = { engine, _renderingContexts: [] } as unknown as FrameGraphContext["surface"];
        const context = { _disposed: false, surface, frameGraph: graph } as unknown as FrameGraphContext;
        const registration = registerFrameGraphContextAsync(context);

        expect(removeTask(graph, task)).toBe(true);
        finishPreload();
        await registration;
        expect(task._preload).toHaveBeenCalledOnce();
        expect(task.record).not.toHaveBeenCalled();
        expect(task.dispose).not.toHaveBeenCalled();
        expect(graph.execute()).toBe(0);
        graph.dispose();
    });
});
