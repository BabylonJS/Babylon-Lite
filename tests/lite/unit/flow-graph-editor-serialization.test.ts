import { describe, expect, it } from "vitest";

import { createFgRuntime, parseFlowGraphEditorJson } from "../../../packages/babylon-lite/src/flow-graph/index";

function connection(uniqueId: string, name: string, connectedPointIds: string[] = [], defaultValue?: unknown) {
    return { uniqueId, name, connectedPointIds, defaultValue };
}

const addGraph = {
    name: "Editor add",
    allBlocks: [
        {
            className: "FlowGraphConstantBlock",
            uniqueId: "left",
            config: { value: 2 },
            dataInputs: [],
            dataOutputs: [connection("left-value", "value", ["add-a"])],
            signalInputs: [],
            signalOutputs: [],
        },
        {
            className: "FlowGraphConstantBlock",
            uniqueId: "right",
            config: { value: 3 },
            dataInputs: [],
            dataOutputs: [connection("right-value", "value", ["add-b"])],
            signalInputs: [],
            signalOutputs: [],
        },
        {
            className: "FlowGraphAddBlock",
            uniqueId: "add",
            config: { type: "number" },
            dataInputs: [connection("add-a", "a", ["left-value"]), connection("add-b", "b", ["right-value"])],
            dataOutputs: [connection("add-value", "value")],
            signalInputs: [],
            signalOutputs: [],
        },
    ],
    executionContexts: [
        {
            uniqueId: "context",
            _userVariables: {
                count: { value: 4, className: "FlowGraphInteger" },
                direction: { value: [1, 2, 3], className: "Vector3" },
            },
            _variableTypes: { count: "FlowGraphInteger", direction: "Vector3" },
            _connectionValues: {},
        },
    ],
};

describe("Flow Graph Editor serialization", () => {
    it("parses coordinator and legacy graph shapes, rich values, and connection IDs", async () => {
        const parsed = await parseFlowGraphEditorJson({
            _flowGraphs: [addGraph, { ...addGraph, executionContexts: [{ ...addGraph.executionContexts[0], uniqueId: "other" }] }],
            activeGraphIndex: 1,
            dispatchEventsSynchronously: false,
        });
        expect(parsed.graphs).toHaveLength(2);
        expect(parsed.activeGraphIndex).toBe(1);
        expect(parsed.dispatchEventsSynchronously).toBe(false);

        const graph = parsed.graphs[0]!;
        expect(graph.variables.count!.value).toEqual({ value: 4, __fgInt: true });
        expect(graph.variables.direction!.value).toEqual({ x: 1, y: 2, z: 3 });
        expect(graph.blocks[2]!.dataIn[0]!.source).toEqual({ blockId: "left", socket: "value" });
        expect(graph.blocks[2]!.dataIn[1]!.source).toEqual({ blockId: "right", socket: "value" });

        const runtime = await createFgRuntime(graph);
        runtime.env.defs.Add!.updateOutputs!(graph.blocks[2]!, runtime.context, runtime.env);
        expect(runtime.context.connectionValues["add:value"]).toBe(5);

        const legacy = await parseFlowGraphEditorJson(addGraph);
        expect(legacy.graphs).toHaveLength(1);
    });

    it("uses context connection values as editor input defaults", async () => {
        const graph = structuredClone(addGraph);
        graph.allBlocks[2]!.dataInputs![0]!.connectedPointIds = [];
        graph.allBlocks[0]!.dataOutputs![0]!.connectedPointIds = [];
        graph.executionContexts[0]!._connectionValues = { "add-a": { value: [7], className: "number" } };
        const parsed = await parseFlowGraphEditorJson(graph);
        expect(parsed.graphs[0]!.blocks[2]!.dataIn[0]!.defaultValue).toBe(7);
    });

    it("reconstructs output-side-only connections and rich-type defaults", async () => {
        const graph = structuredClone(addGraph);
        graph.allBlocks[2]!.dataInputs![0]!.connectedPointIds = [];
        graph.allBlocks[2]!.dataInputs![1]!.connectedPointIds = [];
        graph.allBlocks[1]!.dataOutputs![0]!.connectedPointIds = [];
        Object.assign(graph.allBlocks[2]!.dataInputs![1]!, { richType: { typeName: "number", defaultValue: 8 } });
        const parsed = await parseFlowGraphEditorJson(graph);
        expect(parsed.graphs[0]!.blocks[2]!.dataIn[0]!.source).toEqual({ blockId: "left", socket: "value" });
        expect(parsed.graphs[0]!.blocks[2]!.dataIn[1]!.defaultValue).toBe(8);
    });

    it("executes serialized object/property-name getter and setter blocks", async () => {
        const target = { nested: { value: 2 } };
        const parsed = await parseFlowGraphEditorJson({
            allBlocks: [
                {
                    className: "FlowGraphSetPropertyBlock",
                    uniqueId: "set",
                    dataInputs: [
                        connection("set-object", "object", [], target),
                        connection("set-property", "propertyName", [], "nested.value"),
                        connection("set-value", "value", [], 9),
                    ],
                    dataOutputs: [],
                    signalInputs: [connection("set-in", "in")],
                    signalOutputs: [connection("set-out", "out"), connection("set-error", "error")],
                },
                {
                    className: "FlowGraphGetPropertyBlock",
                    uniqueId: "get",
                    dataInputs: [connection("get-object", "object", [], target), connection("get-property", "propertyName", [], "nested.value")],
                    dataOutputs: [connection("get-value", "value"), connection("get-valid", "isValid")],
                    signalInputs: [],
                    signalOutputs: [],
                },
            ],
            executionContexts: [],
        });
        const graph = parsed.graphs[0]!;
        const runtime = await createFgRuntime(graph);
        runtime.env.defs.SetProperty!.execute!(graph.blocks[0]!, runtime.context, runtime.env, "in");
        runtime.env.defs.GetProperty!.updateOutputs!(graph.blocks[1]!, runtime.context, runtime.env);
        expect(target.nested.value).toBe(9);
        expect(runtime.context.connectionValues["get:value"]).toBe(9);
        expect(runtime.context.connectionValues["get:isValid"]).toBe(true);
    });

    it("rejects editor interpolation instead of mapping it to incompatible KHR interpolation", async () => {
        await expect(
            parseFlowGraphEditorJson({
                allBlocks: [
                    {
                        className: "FlowGraphInterpolationBlock",
                        uniqueId: "interpolation",
                        dataInputs: [],
                        dataOutputs: [],
                        signalInputs: [],
                        signalOutputs: [],
                    },
                ],
                executionContexts: [],
            })
        ).rejects.toThrow(/unsupported block class "FlowGraphInterpolationBlock"/);
    });

    it("fails loudly for editor block classes not ported to Lite", async () => {
        await expect(
            parseFlowGraphEditorJson({
                allBlocks: [
                    {
                        className: "FlowGraphApplyForceBlock",
                        uniqueId: "physics",
                        dataInputs: [],
                        dataOutputs: [],
                        signalInputs: [],
                        signalOutputs: [],
                    },
                ],
                executionContexts: [],
            })
        ).rejects.toThrow(/unsupported block class "FlowGraphApplyForceBlock"/);
    });
});
