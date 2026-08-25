import { describe, expect, it } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { addTask } from "../../../packages/babylon-lite/src/frame-graph/frame-graph-actions";
import { buildFrameGraphTask, createFrameGraph } from "../../../packages/babylon-lite/src/frame-graph/frame-graph";
import type { Pass } from "../../../packages/babylon-lite/src/frame-graph/pass";
import type { Task } from "../../../packages/babylon-lite/src/frame-graph/task";

function makeTask(name: string, events: string[]): Task {
    const task = {
        name,
        engine: {} as EngineContext,
        _passes: [] as Pass[],
        record(): void {
            events.push(`${name}:record`);
            task._passes.push({
                name: `${name}-pass`,
                _parentTask: task,
                _dependencies: new Set(),
                _executeFunc: null,
                _beforeExecute: null,
                _initialize(): void {
                    events.push(`${name}:initialize`);
                },
                _execute: () => 0,
                _dispose: () => {},
            });
        },
        dispose: () => {},
    } satisfies Task;
    return task;
}

describe("FrameGraph runtime task insertion", () => {
    it("records and initializes a newly added task without rebuilding existing tasks", () => {
        const events: string[] = [];
        const graph = createFrameGraph({} as EngineContext);
        const existing = makeTask("existing", events);
        addTask(graph, existing);
        graph.build();

        const runtime = makeTask("runtime", events);
        addTask(graph, runtime);
        buildFrameGraphTask(graph, runtime);

        expect(events).toEqual(["existing:record", "existing:initialize", "runtime:record", "runtime:initialize"]);
    });

    it("keeps disabled tasks recorded but skips both built-in execution and recorded passes", () => {
        const graph = createFrameGraph({} as EngineContext);
        let builtInExecutions = 0;
        let passExecutions = 0;
        const builtIn: Task = {
            name: "built-in",
            engine: {} as EngineContext,
            executionEnabled: false,
            _passes: [],
            record(): void {},
            execute(): number {
                builtInExecutions++;
                return 2;
            },
            dispose(): void {},
        };
        const passTask = makeTask("pass-backed", []);
        passTask.executionEnabled = false;
        addTask(graph, builtIn);
        addTask(graph, passTask);
        graph.build();
        passTask._passes[0]!._execute = () => {
            passExecutions++;
            return 3;
        };

        expect(graph.execute()).toBe(0);
        expect(builtInExecutions).toBe(0);
        expect(passExecutions).toBe(0);

        builtIn.executionEnabled = true;
        passTask.executionEnabled = true;
        expect(graph.execute()).toBe(5);
        expect(builtInExecutions).toBe(1);
        expect(passExecutions).toBe(1);
    });

    it("does not interpret a task-specific enabled state as the frame-graph execution gate", () => {
        const graph = createFrameGraph({} as EngineContext);
        let executions = 0;
        const task = {
            name: "domain-enabled-state",
            engine: {} as EngineContext,
            enabled: false,
            _passes: [],
            record(): void {},
            execute(): number {
                executions++;
                return 1;
            },
            dispose(): void {},
        };
        addTask(graph, task);
        graph.build();

        expect(graph.execute()).toBe(1);
        expect(executions).toBe(1);
    });
});
