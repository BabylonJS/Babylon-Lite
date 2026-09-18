import { describe, expect, it } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { addTask } from "../../../packages/babylon-lite/src/frame-graph/frame-graph-actions";
import { buildFrameGraphTask, createFrameGraph } from "../../../packages/babylon-lite/src/frame-graph/frame-graph";
import { disposeFrameGraphContext, registerFrameGraphContextAsync, type FrameGraphContext } from "../../../packages/babylon-lite/src/frame-graph/frame-graph-context";
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

    it("awaits standalone task preloads before recording the frame graph", async () => {
        const events: string[] = [];
        const engine = {} as EngineContext;
        const graph = createFrameGraph(engine);
        const task = makeTask("compute", events);
        task._preload = async () => {
            await Promise.resolve();
            events.push("compute:preload");
        };
        addTask(graph, task);
        const surface = { engine, _renderingContexts: [] } as unknown as FrameGraphContext["surface"];
        const context = {
            _disposed: false,
            surface,
            frameGraph: graph,
        } as unknown as FrameGraphContext;

        await registerFrameGraphContextAsync(context);

        expect(events).toEqual(["compute:preload", "compute:record", "compute:initialize"]);
        expect(surface._renderingContexts).toContain(context);
    });

    it("does not register a standalone context disposed during preload", async () => {
        const events: string[] = [];
        const engine = {} as EngineContext;
        const graph = createFrameGraph(engine);
        let finishPreload!: () => void;
        const task = makeTask("compute", events);
        task._preload = () =>
            new Promise<void>((resolve) => {
                finishPreload = resolve;
            });
        addTask(graph, task);
        const surface = { engine, _renderingContexts: [] } as unknown as FrameGraphContext["surface"];
        const context = {
            _disposed: false,
            surface,
            frameGraph: graph,
        } as unknown as FrameGraphContext;

        const registration = registerFrameGraphContextAsync(context);
        disposeFrameGraphContext(context);
        finishPreload();
        await registration;

        expect(events).toEqual([]);
        expect(surface._renderingContexts).not.toContain(context);
    });
});
