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
});
