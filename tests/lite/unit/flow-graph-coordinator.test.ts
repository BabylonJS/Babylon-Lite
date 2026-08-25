import { describe, expect, it, vi } from "vitest";

import type { FgBlockDef, FgValue, SceneContext } from "../../../packages/babylon-lite/src/index";
import {
    addFlowGraph,
    buildFgGraph,
    createFgEventBus,
    createFgRuntime,
    detachFlowGraph,
    dispatchFlowGraphEvent,
    FgEventType,
    FgType,
    flowGraphBus,
    flowGraphRuntimes,
    getDataValue,
    startFlowGraph,
} from "../../../packages/babylon-lite/src/index";
import { dispatchFlowGraphPointerPick } from "../../../packages/babylon-lite/src/flow-graph/scene-flow-graph";
import { createEmptyPickingInfo } from "../../../packages/babylon-lite/src/picking/picking-info";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";

// Minimal fake scene exposing only the seams the flow-graph driver uses
// (onBeforeRender pushes to `_beforeRender`, onSceneDispose to `_disposables`).
function fakeScene(): SceneContext {
    return { _beforeRender: [], _disposables: [] } as unknown as SceneContext;
}

function driveFrame(scene: SceneContext, deltaMs: number): void {
    for (const cb of (scene as unknown as { _beforeRender: ((d: number) => void)[] })._beforeRender.slice()) {
        cb(deltaMs);
    }
}

const RECORD = "test/record";
function recorderDef(log: { label: string; value: FgValue }[]): FgBlockDef {
    return {
        type: RECORD,
        build: () => ({ signalIn: [{ name: "in", targets: [] }], dataIn: [{ name: "value", type: FgType.Any }] }),
        execute: (block, ctx, env) => log.push({ label: (block.config?.label as string) ?? "", value: getDataValue(ctx, env, block, "value") }),
    };
}

describe("flow-graph coordinator — imperative build + run", () => {
    it("buildFgGraph + addFlowGraph runs a graph without a glTF asset", async () => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            const scene = fakeScene();
            const graph = await buildFgGraph([
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "log", socket: "in" }] } },
                { id: "log", type: "ConsoleLog", dataDefaults: { message: "hi from builder" } },
            ]);
            const rt = await addFlowGraph(scene, graph);
            expect(flowGraphRuntimes(scene)).toContain(rt);

            driveFrame(scene, 16); // first frame starts + ticks the graph
            expect(spy).toHaveBeenCalledWith("hi from builder");
        } finally {
            spy.mockRestore();
        }
    });

    it("buildFgGraph throws loudly on an unknown block type", async () => {
        await expect(buildFgGraph([{ id: "x", type: "NotARealBlock" }])).rejects.toThrow(/unknown block type/i);
    });

    it("dispatchFlowGraphEvent delivers a custom event to a graph's receiver", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const scene = fakeScene();
        const graph = await buildFgGraph(
            [
                {
                    id: "recv",
                    type: "ReceiveCustomEvent",
                    config: { eventId: "ping", valueNames: ["n"] },
                    signalTargets: { out: [{ blockId: "rec", socket: "in" }] },
                },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "recv", socket: "n" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        const rt = await addFlowGraph(scene, graph, { defs: { [RECORD]: recorderDef(log) } });
        startFlowGraph(rt); // subscribe the receiver before dispatching

        dispatchFlowGraphEvent(scene, "ping", { n: 42 });
        expect(log).toHaveLength(1);
        expect(log[0]!.value).toBe(42);
    });

    it("two graphs on one scene exchange custom events via the shared scene bus", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const scene = fakeScene();

        const receiver = await buildFgGraph(
            [
                {
                    id: "recv",
                    type: "ReceiveCustomEvent",
                    config: { eventId: "go", valueNames: ["n"] },
                    signalTargets: { out: [{ blockId: "rec", socket: "in" }] },
                },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "recv", socket: "n" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        const sender = await buildFgGraph([
            { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "send", socket: "in" }] } },
            { id: "send", type: "SendCustomEvent", config: { eventId: "go", valueNames: ["n"] }, dataDefaults: { n: 7 } },
        ]);

        const rtRecv = await addFlowGraph(scene, receiver, { defs: { [RECORD]: recorderDef(log) } });
        const rtSend = await addFlowGraph(scene, sender);
        // Both graphs share one scene bus.
        expect(rtRecv.env.events).toBe(flowGraphBus(scene));
        expect(rtSend.env.events).toBe(rtRecv.env.events);

        startFlowGraph(rtRecv); // receiver subscribes first
        startFlowGraph(rtSend); // sender's onStart fires → send → received
        expect(log).toHaveLength(1);
        expect(log[0]!.value).toBe(7);
    });

    it("keeps stopImmediate scoped to the receiving graph", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const scene = fakeScene();
        const stoppingGraph = await buildFgGraph([
            {
                id: "recv",
                type: "ReceiveCustomEvent",
                config: { eventId: "halt" },
                signalTargets: { out: [{ blockId: "stop", socket: "in" }] },
            },
            {
                id: "stop",
                type: "StopEventPropagation",
                dataDefaults: { stopImmediate: true },
                dataSources: { event: { blockId: "recv", socket: "event" } },
            },
        ]);
        const otherGraph = await buildFgGraph(
            [
                {
                    id: "recv",
                    type: "ReceiveCustomEvent",
                    config: { eventId: "halt" },
                    signalTargets: { out: [{ blockId: "rec", socket: "in" }] },
                },
                { id: "rec", type: RECORD },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        const first = await addFlowGraph(scene, stoppingGraph);
        const second = await addFlowGraph(scene, otherGraph, { defs: { [RECORD]: recorderDef(log) } });
        startFlowGraph(first);
        startFlowGraph(second);

        dispatchFlowGraphEvent(scene, "halt");
        expect(log).toHaveLength(1);
    });

    it("pumps one shared tick per frame regardless of graph count", async () => {
        let ticks = 0;
        const tickDef: FgBlockDef = {
            type: "test/tick",
            build: () => ({ event: FgEventType.Tick }),
            execute: () => {
                ticks++;
            },
        };
        const scene = fakeScene();
        const graph = await buildFgGraph([{ id: "tick", type: "test/tick" }], { defs: { "test/tick": tickDef } });
        await addFlowGraph(scene, graph, { defs: { "test/tick": tickDef } });
        await addFlowGraph(scene, graph, { defs: { "test/tick": tickDef } });

        driveFrame(scene, 16);
        expect(ticks).toBe(2);
    });

    it("drives runtimes that use an explicitly supplied event bus", async () => {
        let ticks = 0;
        const tickDef: FgBlockDef = {
            type: "test/external-tick",
            build: () => ({ event: FgEventType.Tick }),
            execute: () => {
                ticks++;
            },
        };
        const scene = fakeScene();
        const graph = await buildFgGraph([{ id: "tick", type: "test/external-tick" }], { defs: { "test/external-tick": tickDef } });
        await addFlowGraph(scene, graph, { defs: { "test/external-tick": tickDef }, events: createFgEventBus() });

        driveFrame(scene, 16);
        expect(ticks).toBe(1);
    });

    it("dispatches a pointer pick once per event bus and respects node selectability", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const bus = createFgEventBus();
        const graph = await buildFgGraph(
            [
                {
                    id: "select",
                    type: "OnSelect",
                    config: { nodeIndex: 7 },
                    signalTargets: { out: [{ blockId: "rec", socket: "in" }] },
                },
                { id: "rec", type: RECORD },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        const first = await createFgRuntime(graph, { events: bus, defs: { [RECORD]: recorderDef(log) } });
        const second = await createFgRuntime(graph, { events: bus, defs: { [RECORD]: recorderDef(log) } });
        startFlowGraph(first);
        startFlowGraph(second);
        const scene = fakeScene();
        scene._flowGraphs = [first, second];
        const pick = createEmptyPickingInfo();
        pick.hit = true;
        pick.pickedMesh = { _gltfNodeIndex: 7 } as Mesh;

        dispatchFlowGraphPointerPick(scene, pick);
        expect(log).toHaveLength(2);

        first.env.accessors["/nodes/7/extensions/KHR_node_selectability/selectable"] = {
            type: FgType.Boolean,
            get: () => false,
        };
        dispatchFlowGraphPointerPick(scene, pick);
        expect(log).toHaveLength(2);

        pick.hit = false;
        dispatchFlowGraphPointerPick(scene, pick);
        expect(log).toHaveLength(2);
    });

    it("subscribes every graph before start flows dispatch cross-graph events", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const scene = fakeScene();
        const sender = await buildFgGraph([
            { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "send", socket: "in" }] } },
            { id: "send", type: "SendCustomEvent", config: { eventId: "ready" } },
        ]);
        const receiver = await buildFgGraph(
            [
                { id: "recv", type: "ReceiveCustomEvent", config: { eventId: "ready" }, signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "rec", type: RECORD },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        await addFlowGraph(scene, sender);
        await addFlowGraph(scene, receiver, { defs: { [RECORD]: recorderDef(log) } });

        driveFrame(scene, 16);
        expect(log).toHaveLength(1);
    });

    it("defers queued custom events until the following frame", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const scene = fakeScene();
        const graph = await buildFgGraph(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "send", socket: "in" }] } },
                { id: "send", type: "SendCustomEvent", config: { eventId: "later", dispatchEventsSynchronously: false } },
                { id: "recv", type: "ReceiveCustomEvent", config: { eventId: "later" }, signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "rec", type: RECORD },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        await addFlowGraph(scene, graph, { defs: { [RECORD]: recorderDef(log) } });

        driveFrame(scene, 16);
        expect(log).toHaveLength(0);
        driveFrame(scene, 16);
        expect(log).toHaveLength(1);
    });

    it("removes coordinator callbacks when the final runtime detaches", async () => {
        const scene = fakeScene();
        const graph = await buildFgGraph([]);
        const first = await addFlowGraph(scene, graph);
        const second = await addFlowGraph(scene, graph);
        expect(scene._beforeRender).toHaveLength(1);
        expect(scene._disposables).toHaveLength(1);

        detachFlowGraph(scene, first);
        expect(scene._beforeRender).toHaveLength(1);
        detachFlowGraph(scene, second);
        expect(scene._beforeRender).toHaveLength(0);
        expect(scene._disposables).toHaveLength(0);
        expect(scene._flowGraphTick).toBeUndefined();
        expect(scene._flowGraphDispose).toBeUndefined();
    });

    it("does not start or tick a runtime detached earlier in the same frame", async () => {
        const scene = fakeScene();
        const detached: { runtime?: Awaited<ReturnType<typeof addFlowGraph>> } = {};
        let ticks = 0;
        const detachDef: FgBlockDef = {
            type: "test/detach",
            build: () => ({ event: FgEventType.Start }),
            execute: () => {
                if (detached.runtime) {
                    detachFlowGraph(scene, detached.runtime);
                }
            },
        };
        const tickDef: FgBlockDef = {
            type: "test/detached-tick",
            build: () => ({ event: FgEventType.Tick }),
            execute: () => {
                ticks++;
            },
        };
        const firstGraph = await buildFgGraph([{ id: "detach", type: "test/detach" }], { defs: { "test/detach": detachDef } });
        const secondGraph = await buildFgGraph([{ id: "tick", type: "test/detached-tick" }], { defs: { "test/detached-tick": tickDef } });
        await addFlowGraph(scene, firstGraph, { defs: { "test/detach": detachDef } });
        detached.runtime = await addFlowGraph(scene, secondGraph, { defs: { "test/detached-tick": tickDef } });

        driveFrame(scene, 16);
        expect(ticks).toBe(0);
        expect(flowGraphRuntimes(scene)).not.toContain(detached.runtime);
    });
});
