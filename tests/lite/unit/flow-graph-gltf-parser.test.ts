import { describe, expect, it, vi } from "vitest";

import type { FgAccessor, FgValue } from "../../../packages/babylon-lite/src/flow-graph/index";
import { createFgRuntime, FgType, startFlowGraph, tickFlowGraph } from "../../../packages/babylon-lite/src/flow-graph/index";
import { parseInteractivityGraph, type GltfInteractivityGraph } from "../../../packages/babylon-lite/src/flow-graph/gltf/interactivity-parser";

// Fixtures mirror Babylon.js loaders/test/unit/Interactivity/testData.ts verbatim
// (refreshed against Babylon.js 9.22.2) so Lite is validated against the real wire format.

const worldPointerExample: GltfInteractivityGraph = {
    declarations: [{ op: "event/onStart" }, { op: "pointer/set" }, { op: "pointer/get" }, { op: "flow/log", extension: "BABYLON" }],
    nodes: [
        { declaration: 0, flows: { out: { node: 1, socket: "in" } } },
        {
            declaration: 1,
            configuration: { pointer: { value: ["/nodes/0/translation"] } },
            values: { value: { value: [1, 1, 1], type: 4 } },
            flows: { out: { node: 3, socket: "in" } },
        },
        {
            declaration: 2,
            configuration: { pointer: { value: ["/nodes/{nodeIndex}/translation"] } },
            values: { nodeIndex: { value: [0], type: 1 } },
        },
        { declaration: 3, values: { message: { node: 2, socket: "value" } } },
    ],
    variables: [],
    events: [],
    types: [{ signature: "bool" }, { signature: "int" }, { signature: "float" }, { signature: "float2" }, { signature: "float3" }],
};

const loggerExample: GltfInteractivityGraph = {
    declarations: [{ op: "event/onStart" }, { op: "flow/log", extension: "BABYLON" }, { op: "math/add" }],
    nodes: [
        { declaration: 0, flows: { out: { node: 2, socket: "in" } } },
        {
            declaration: 2,
            values: {
                a: { value: [1, 2, 3, 4], type: 0 },
                b: { value: [1, 2, 3, 4], type: 0 },
            },
        },
        { declaration: 1, values: { message: { node: 1, socket: "value" } } },
    ],
    types: [{ signature: "float4" }],
};

describe("KHR_interactivity parser", () => {
    it("parses the worldPointer graph: topology, config, pointers", async () => {
        const { graph, pointers } = await parseInteractivityGraph(worldPointerExample);

        expect(graph.blocks.map((b) => b.type)).toEqual(["SceneReadyEvent", "SetProperty", "GetProperty", "ConsoleLog"]);
        expect(pointers).toEqual(["/nodes/0/translation"]);

        // onStart `out` flow maps to the SceneReadyEvent `done` signal → node_1.in
        const start = graph.blocks[0]!;
        const done = start.signalOut.find((s) => s.name === "done")!;
        expect(done.targets).toEqual([{ blockId: "node_1", socket: "in" }]);

        // pointer/set resolves config.accessor + literal Vector3 value, and wires out→node_3
        const set = graph.blocks[1]!;
        expect(set.config?.accessor).toBe("/nodes/0/translation");
        expect(set.dataIn.find((d) => d.name === "value")!.defaultValue).toEqual({ x: 1, y: 1, z: 1 });
        expect(set.signalOut.find((s) => s.name === "out")!.targets).toEqual([{ blockId: "node_3", socket: "in" }]);

        // pointer/get template `{nodeIndex}` substituted from the literal value socket
        expect(graph.blocks[2]!.config?.accessor).toBe("/nodes/0/translation");

        // ConsoleLog pulls `message` from GetProperty.value
        const log = graph.blocks[3]!;
        expect(log.dataIn.find((d) => d.name === "message")!.source).toEqual({ blockId: "node_2", socket: "value" });
    });

    it("coerces a float4 literal into a Vector4 and wires a data reference", async () => {
        const { graph } = await parseInteractivityGraph(loggerExample);
        const add = graph.blocks[1]!;
        expect(add.type).toBe("Add");
        expect(add.dataIn.find((d) => d.name === "a")!.defaultValue).toEqual({ x: 1, y: 2, z: 3, w: 4 });
        // ConsoleLog message references the add node's default `value` output
        expect(graph.blocks[2]!.dataIn.find((d) => d.name === "message")!.source).toEqual({ blockId: "node_1", socket: "value" });
    });

    it("runs end-to-end: onStart → pointer/set writes through the resolved accessor", async () => {
        const { graph, pointers } = await parseInteractivityGraph(worldPointerExample);
        const box = { v: { x: 0, y: 0, z: 0 } as FgValue };
        const accessor: FgAccessor = {
            type: graph.blocks[1]!.dataIn[0]!.type,
            get: () => box.v,
            set: (value) => {
                box.v = value;
            },
        };
        const accessors = Object.fromEntries(pointers.map((p) => [p, accessor]));
        const rt = await createFgRuntime(graph, { accessors });
        startFlowGraph(rt);
        expect(box.v).toEqual({ x: 1, y: 1, z: 1 });
    });

    it("demotes an unsupported declaration to a typed no-op", async () => {
        const bad: GltfInteractivityGraph = {
            declarations: [{ op: "event/onStart" }, { op: "math/teleport", outputValueSockets: { result: { type: 0 } }, inputFlowSockets: { in: {} } }],
            nodes: [{ declaration: 0, flows: { out: { node: 1, socket: "in" } } }, { declaration: 1 }],
            types: [{ signature: "float" }],
        };
        const { graph } = await parseInteractivityGraph(bad);
        expect(graph.blocks[1]).toMatchObject({ type: "NoOp", dataOut: [{ name: "result", type: "number" }] });
    });

    it("resolves a pointer segment from a live data connection", async () => {
        const dyn: GltfInteractivityGraph = {
            declarations: [{ op: "event/onStart" }, { op: "math/add" }, { op: "pointer/set" }],
            nodes: [
                { declaration: 0, flows: { out: { node: 2 } } },
                { declaration: 1, values: { a: { type: 0, value: [1] }, b: { type: 0, value: [1] } } },
                {
                    declaration: 2,
                    configuration: { pointer: { value: ["/nodes/{nodeIndex}/translation"] } },
                    values: { nodeIndex: { node: 1 }, value: { value: [1, 1, 1], type: 1 } },
                },
            ],
            types: [{ signature: "float" }, { signature: "float3" }],
        };
        const { graph, pointers } = await parseInteractivityGraph(dyn);
        expect(pointers).toEqual([]);
        expect(graph.blocks[2]!.config).toMatchObject({ pointerTemplate: "/nodes/{nodeIndex}/translation", pointerSegments: ["nodeIndex"] });

        const box = { value: null as FgValue };
        const rt = await createFgRuntime(graph, {
            resolveAccessor: (pointer) =>
                pointer === "/nodes/2/translation"
                    ? {
                          type: graph.blocks[2]!.dataIn[0]!.type,
                          get: () => box.value,
                          set: (value) => (box.value = value),
                      }
                    : null,
        });
        startFlowGraph(rt);
        expect(box.value).toEqual({ x: 1, y: 1, z: 1 });
    });

    it("uses release-candidate defaults and resolves event declarations", async () => {
        const g: GltfInteractivityGraph = {
            types: [{ signature: "float" }, { signature: "float2" }, { signature: "ref" }],
            variables: [{ type: 0 }, { type: 1 }, { type: 2 }],
            events: [{ id: "changed", values: { amount: { type: 0, value: [3] }, target: { type: 2 } } }],
            declarations: [{ op: "event/send" }, { op: "event/receive" }],
            nodes: [
                { declaration: 0, configuration: { event: { value: [0] } } },
                { declaration: 1, configuration: { event: { value: [0] } } },
            ],
        };
        const { graph } = await parseInteractivityGraph(g);
        expect(graph.variables["0"]!.value).toBeNaN();
        expect(graph.variables["1"]!.value).toEqual({ x: NaN, y: NaN });
        expect(graph.variables["2"]!.value).toBe("");
        expect(graph.blocks[0]!.config).toMatchObject({
            eventId: "changed",
            valueNames: ["amount", "target"],
            valueTypes: ["number", "ref"],
            valueDefaults: { amount: 3, target: "" },
            dispatchEventsSynchronously: false,
        });
        expect(graph.blocks[1]!.dataOut.map(({ name, type }) => ({ name, type }))).toEqual([
            { name: "event", type: "ref" },
            { name: "amount", type: "number" },
            { name: "target", type: "ref" },
        ]);
    });

    it("maps multi-variable assignment", async () => {
        const g: GltfInteractivityGraph = {
            types: [{ signature: "float" }],
            variables: [{ type: 0 }, { type: 0 }],
            declarations: [{ op: "event/onStart" }, { op: "event/onTick" }, { op: "variable/set" }],
            nodes: [
                { declaration: 0 },
                { declaration: 1 },
                {
                    declaration: 2,
                    configuration: { variables: { value: [0, 1] } },
                    values: { "0": { type: 0, value: [2] }, "1": { type: 0, value: [3] } },
                },
            ],
        };
        const { graph } = await parseInteractivityGraph(g);
        expect(graph.blocks[2]!.config?.variables).toEqual([0, 1]);
        expect(graph.blocks[2]!.dataIn.map(({ name, defaultValue }) => ({ name, defaultValue }))).toEqual([
            { name: "0", defaultValue: 2 },
            { name: "1", defaultValue: 3 },
        ]);
    });

    it.each([
        { variables: [] as number[], values: {}, error: /invalid variable indices/ },
        { variables: [0, 0], values: { "0": { type: 0, value: [2] } }, error: /invalid variable indices/ },
        { variables: [1], values: { "1": { type: 0, value: [2] } }, error: /invalid variable indices/ },
        { variables: [0], values: {}, error: /missing input/ },
        { variables: [0], values: { "0": { type: 1, value: [true] } }, error: /wrong type/ },
    ])("rejects invalid variable/set declarations", async ({ variables, values, error }) => {
        const g: GltfInteractivityGraph = {
            types: [{ signature: "float" }, { signature: "bool" }],
            variables: [{ type: 0 }],
            declarations: [{ op: "variable/set" }],
            nodes: [
                {
                    declaration: 0,
                    configuration: { variables: { value: variables } },
                    values: values as NonNullable<NonNullable<GltfInteractivityGraph["nodes"]>[number]["values"]>,
                },
            ],
        };
        await expect(parseInteractivityGraph(g)).rejects.toThrow(error);
    });

    it("runs variable/interpolate with cubic-Bezier inputs against the live variable", async () => {
        const g: GltfInteractivityGraph = {
            types: [{ signature: "float" }, { signature: "float2" }],
            variables: [{ type: 0, value: [0] }],
            declarations: [{ op: "event/onStart" }, { op: "variable/interpolate" }],
            nodes: [
                { declaration: 0, flows: { out: { node: 1, socket: "in" } } },
                {
                    declaration: 1,
                    configuration: { variable: { value: [0] }, useSlerp: { value: [false] } },
                    values: {
                        value: { type: 0, value: [10] },
                        duration: { type: 0, value: [1] },
                        p1: { type: 1, value: [0, 0] },
                        p2: { type: 1, value: [1, 1] },
                    },
                },
            ],
        };
        const { graph } = await parseInteractivityGraph(g);
        const rt = await createFgRuntime(graph);
        startFlowGraph(rt);
        expect(rt.context.userVariables["0"]).toBe(0);
        tickFlowGraph(rt, 500);
        expect(rt.context.userVariables["0"]).toBeCloseTo(5, 5);
        tickFlowGraph(rt, 500);
        expect(rt.context.userVariables["0"]).toBe(10);
    });

    it("runs pointer/interpolate against its resolved property accessor", async () => {
        const pointer = "/nodes/0/translation";
        const g: GltfInteractivityGraph = {
            types: [{ signature: "float" }, { signature: "float2" }, { signature: "float3" }],
            declarations: [{ op: "event/onStart" }, { op: "pointer/interpolate" }],
            nodes: [
                { declaration: 0, flows: { out: { node: 1, socket: "in" } } },
                {
                    declaration: 1,
                    configuration: { pointer: { value: [pointer] }, type: { value: [2] } },
                    values: {
                        value: { type: 2, value: [2, 4, 6] },
                        duration: { type: 0, value: [1] },
                        p1: { type: 1, value: [0, 0] },
                        p2: { type: 1, value: [1, 1] },
                    },
                },
            ],
        };
        const target = { x: 0, y: 0, z: 0 };
        const accessor: FgAccessor = {
            type: FgType.Vector3,
            get: () => target,
            set: (value) => Object.assign(target, value as typeof target),
        };
        const { graph } = await parseInteractivityGraph(g);
        const rt = await createFgRuntime(graph, { accessors: { [pointer]: accessor } });
        startFlowGraph(rt);
        tickFlowGraph(rt, 500);
        expect(target).toEqual({ x: 1, y: 2, z: 3 });
        tickFlowGraph(rt, 500);
        expect(target).toEqual({ x: 2, y: 4, z: 6 });
    });

    it("scales connected animation times from seconds to frames at runtime", async () => {
        const g: GltfInteractivityGraph = {
            types: [{ signature: "float" }, { signature: "int" }],
            declarations: [{ op: "math/add" }, { op: "animation/start" }],
            nodes: [
                { declaration: 0, values: { a: { type: 0, value: [1] }, b: { type: 0, value: [1] } } },
                { declaration: 1, values: { animation: { type: 1, value: [0] }, startTime: { node: 0 } } },
            ],
        };
        const { graph } = await parseInteractivityGraph(g);
        expect(graph.blocks[1]!.dataIn.find((socket) => socket.name === "from")!.source).toEqual({
            blockId: "node_0",
            socket: "value",
            scale: 60,
        });
    });
});

describe("KHR_interactivity parser — pointer templating & new ops", () => {
    it("extracts the trailing index from a `ref` placeholder value (/materials/4/ → 4)", async () => {
        const g: GltfInteractivityGraph = {
            declarations: [{ op: "pointer/get" }],
            nodes: [
                {
                    declaration: 0,
                    configuration: { pointer: { value: ["/materials/{materialRef}/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/scale"] } },
                    values: { materialRef: { type: 5, value: ["/materials/4/"] } },
                },
            ],
            types: [{ signature: "bool" }, { signature: "int" }, { signature: "float" }, { signature: "float2" }, { signature: "float3" }, { signature: "ref" }],
        };
        const { graph, pointers } = await parseInteractivityGraph(g);
        expect(pointers).toEqual(["/materials/4/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/scale"]);
        expect(graph.blocks[0]!.config?.accessor).toBe("/materials/4/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/scale");
    });

    it("supports canonical integer parameters and RFC 6901-decoded parameter IDs", async () => {
        const g: GltfInteractivityGraph = {
            declarations: [{ op: "pointer/get" }],
            nodes: [
                {
                    declaration: 0,
                    configuration: { pointer: { value: ["/nodes/[node~1index]/translation"] } },
                    values: { "node/index": { type: 1, value: [22] } },
                },
            ],
            types: [{ signature: "bool" }, { signature: "int" }, { signature: "float" }, { signature: "float2" }, { signature: "float3" }, { signature: "ref" }],
        };
        const { pointers } = await parseInteractivityGraph(g);
        expect(pointers).toEqual(["/nodes/22/translation"]);
    });

    it("treats doubled brackets as pointer literals", async () => {
        const g: GltfInteractivityGraph = {
            declarations: [{ op: "pointer/get" }],
            nodes: [{ declaration: 0, configuration: { pointer: { value: ["/nodes/[[literal]]/translation"] } } }],
            types: [],
        };
        const { pointers } = await parseInteractivityGraph(g);
        expect(pointers).toEqual(["/nodes/[literal]/translation"]);
    });

    it.each([
        { pointer: "nodes/[index]", values: { index: { type: 0, value: [0] } }, error: /must be absolute/ },
        { pointer: "/nodes/[]", values: {}, error: /literal pointer brackets must be doubled/ },
        { pointer: "/nodes/[same]/{same}", values: { same: { type: 0, value: [0] } }, error: /duplicate pointer parameter/ },
        { pointer: "/nodes/[value]", values: { value: { type: 0, value: [0] } }, error: /reserved pointer parameter/ },
    ])("rejects invalid pointer templates", async ({ pointer, values, error }) => {
        const g: GltfInteractivityGraph = {
            declarations: [{ op: "pointer/set" }],
            nodes: [
                {
                    declaration: 0,
                    configuration: { pointer: { value: [pointer] } },
                    values: values as NonNullable<NonNullable<GltfInteractivityGraph["nodes"]>[number]["values"]>,
                },
            ],
            types: [{ signature: "int" }],
        };
        await expect(parseInteractivityGraph(g)).rejects.toThrow(error);
    });

    it("maps the new math ops and renames extract2 outputs to x/y", async () => {
        const g: GltfInteractivityGraph = {
            declarations: [
                { op: "math/extract2" }, // 0
                { op: "math/combine2" }, // 1
                { op: "math/clamp" }, // 2
                { op: "math/sub" }, // 3
                { op: "flow/log", extension: "BABYLON" }, // 4
            ],
            nodes: [
                { declaration: 0, values: { a: { value: [3, 4], type: 3 } } },
                { declaration: 1, values: { a: { value: [1], type: 2 }, b: { value: [2], type: 2 } } },
                { declaration: 2, values: { a: { value: [5], type: 2 }, b: { value: [0], type: 2 }, c: { value: [9], type: 2 } } },
                { declaration: 3, values: { a: { value: [7], type: 2 }, b: { value: [2], type: 2 } } },
                // ConsoleLog pulls extract2's "1" output → must resolve to the Lite `y` socket
                { declaration: 4, values: { message: { node: 0, socket: "1" } } },
            ],
            types: [{ signature: "bool" }, { signature: "int" }, { signature: "float" }, { signature: "float2" }],
        };
        const { graph } = await parseInteractivityGraph(g);
        expect(graph.blocks.map((b) => b.type)).toEqual(["ExtractVector2", "CombineVector2", "Clamp", "Subtract", "ConsoleLog"]);
        expect(graph.blocks[4]!.dataIn.find((d) => d.name === "message")!.source).toEqual({ blockId: "node_0", socket: "y" });
    });

    it("maps event/onSelect (KHR_node_selectability) and copies nodeIndex into config", async () => {
        const g: GltfInteractivityGraph = {
            declarations: [{ op: "event/onSelect", extension: "KHR_node_selectability" }],
            nodes: [{ declaration: 0, configuration: { nodeIndex: { value: [14] } } }],
            types: [],
        };
        const { graph } = await parseInteractivityGraph(g);
        expect(graph.blocks[0]!.type).toBe("OnSelect");
        expect(graph.blocks[0]!.config?.nodeIndex).toBe(14);
    });
});

// Silence the ConsoleLog block's console.log in the end-to-end run.
vi.spyOn(console, "log").mockImplementation(() => {});

// ─────────────────────────────────────────────────────────────────────────────
// Coverage guard: every mapped glTF op must resolve to a registered block def.
// Prevents adding an op mapping without wiring its block into the registry.
// ─────────────────────────────────────────────────────────────────────────────

describe("declaration-mapper — block coverage", () => {
    it("every mapped block type resolves to a registered, type-matching def", async () => {
        const { allMappedBlockTypes } = await import("../../../packages/babylon-lite/src/flow-graph/gltf/declaration-mapper");
        const { getBlockDef } = await import("../../../packages/babylon-lite/src/flow-graph/index");
        for (const type of allMappedBlockTypes()) {
            const factory = getBlockDef(type);
            expect(factory, `no registry entry for mapped block type "${type}"`).toBeTruthy();
            const def = await factory!();
            expect(def.type).toBe(type);
        }
    });

    it("maps every release-candidate operation added after the original port", async () => {
        const { getOpMapping } = await import("../../../packages/babylon-lite/src/flow-graph/gltf/declaration-mapper");
        expect(
            [
                "event/stopPropagation",
                "math/Tau",
                "math/smoothStep",
                "math/rgbToOkLCh",
                "math/rgbFromOkLCh",
                "math/quatSlerp",
                "math/slerp",
                "ref/eq",
                "math/quatFromUpForward",
                "math/quatFromAngles",
            ].map((op) => getOpMapping(op)?.block)
        ).toEqual([
            "StopEventPropagation",
            "Tau",
            "SmoothStep",
            "RGBToOkLCh",
            "RGBFromOkLCh",
            "MathSlerp",
            "VectorSlerp",
            "Equality",
            "QuaternionFromUpForward",
            "QuaternionFromAngles",
        ]);
    });
});
