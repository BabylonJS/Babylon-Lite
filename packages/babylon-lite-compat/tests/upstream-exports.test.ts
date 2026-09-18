import { describe, expect, it } from "vitest";

import {
    GLTF2,
    FlowGraphValidationSeverity,
    RegisterEnginesExtensionsEngineTexture2DArrayImageSource,
    RegisterEnginesWebGPUExtensionsEngineTexture2DArrayImageSource,
    ValidateFlowGraph,
} from "../src/index";
import { LiteCompatError } from "../src/error";
import type { IGLTFToFlowGraphMapping } from "../src/loading/unsupported-khr-interactivity";

interface UpstreamNode {
    declaration: number;
    values?: Record<string, { type: number; value?: Array<boolean | number | string> } | { node: number; socket?: string; type?: number }>;
}

interface UpstreamGraph {
    types?: Array<{ signature: "float" }>;
}

interface UpstreamGltf {
    asset: { version: string };
    nodes?: unknown[];
}

interface UpstreamConnection {
    uniqueId: string;
    name: string;
    _connectionType: number;
    connectedPointIds: string[];
}

describe("upstream export coverage", () => {
    it("exposes the texture-array pure registration shims", () => {
        expect(RegisterEnginesExtensionsEngineTexture2DArrayImageSource()).toBeUndefined();
        expect(RegisterEnginesWebGPUExtensionsEngineTexture2DArrayImageSource()).toBeUndefined();
    });

    it("exposes FlowGraph validation symbols with a structural failure", () => {
        expect(FlowGraphValidationSeverity.Error).toBe(0);
        expect(FlowGraphValidationSeverity.Warning).toBe(1);
        expect(() => ValidateFlowGraph({})).toThrow(LiteCompatError);
        expect(() => ValidateFlowGraph({})).toThrow(/ValidateFlowGraph/);
    });

    it("exposes KHR_interactivity canonical-model and block symbols", () => {
        expect(GLTF2.KHR_INTERACTIVITY_SPECIFICATION_COMMIT).toBe("f798712c5685bc9223a628140fba707db8889300");
        expect(GLTF2.FlowGraphEventReferenceBlock).toBeTypeOf("function");
        expect(GLTF2.InteractivityGraphToFlowGraphParser).toBeTypeOf("function");
        expect(GLTF2.gltfTypeToBabylonType.float).toEqual({ length: 1, flowGraphType: "number", elementType: "number" });
        expect(() => GLTF2.getMappingForDeclaration({})).toThrow(LiteCompatError);
        expect(() => GLTF2.CreateKHRInteractivityDocument({})).toThrow(LiteCompatError);
        expect(() => GLTF2.CreateKHRInteractivityDocument({})).toThrow(/GLTF2\.CreateKHRInteractivityDocument/);
    });

    it("preserves the optional KHR_interactivity mapping hooks", () => {
        const validation = (node: UpstreamNode, graph: UpstreamGraph, gltf?: UpstreamGltf) => ({
            valid: !!node.values && !!graph.types && !!gltf?.nodes,
            error: "invalid",
        });
        const mapping: IGLTFToFlowGraphMapping = {
            blocks: ["test"],
            interBlockConnectors: [{ input: "in", output: "out", inputBlockIndex: 0, outputBlockIndex: 1, isVariable: true }],
            validation,
            extraProcessor: (_node, _declaration, _mapping, parser, serializedObjects) => {
                expect(parser.arrays.types[0]?.flowGraphType).toBe("number");
                expect(parser.arrays.mappings[0]?.flowGraphMapping.blocks).toEqual(["test"]);
                expect(parser.arrays.mappings[0]?.declaration.operation).toBe("math/add");
                expect(parser.arrays.mappings[0]?.declaration.source.op).toBe("math/add");
                expect(parser.arrays.staticVariables[0]?.value).toEqual([1]);
                return serializedObjects;
            },
        };
        const connection: UpstreamConnection = {
            uniqueId: "connection",
            name: "value",
            _connectionType: 0,
            connectedPointIds: [],
        };
        const serialized = mapping.extraProcessor!(
            { declaration: 0 },
            { op: "test" },
            mapping,
            {
                _animationTargetFps: 60,
                arrays: {
                    types: [{ length: 1, flowGraphType: "number", elementType: "number" }],
                    mappings: [
                        {
                            flowGraphMapping: mapping,
                            fullOperationName: "math/add",
                            declaration: {
                                index: 0,
                                operation: "math/add",
                                support: "core",
                                source: { op: "math/add" },
                            },
                        },
                    ],
                    staticVariables: [{ type: "number", value: [1] }],
                    events: [],
                    nodes: [],
                },
                getVariableName: (index) => `staticVariable_${index}`,
                serializeToFlowGraph: () => ({ executionContexts: [], allBlocks: [] }),
            },
            [
                {
                    className: "Block",
                    type: "test",
                    config: {},
                    uniqueId: "block",
                    dataInputs: [connection],
                    dataOutputs: [],
                    metadata: {},
                    signalInputs: [],
                    signalOutputs: [],
                },
            ],
            { uniqueId: "context", _userVariables: {}, _connectionValues: {} }
        );

        expect(mapping.interBlockConnectors?.[0]?.outputBlockIndex).toBe(1);
        expect(mapping.validation?.({ declaration: 0, values: {} }, { types: [] }, { asset: { version: "2.0" }, nodes: [] })).toEqual({ valid: true, error: "invalid" });
        expect(serialized[0]?.dataInputs[0]?.name).toBe("value");
        expect(serialized[0]?.dataInputs[0]?.connectedPointIds).toEqual([]);
    });

    it("implements the pure KHR_interactivity registry helpers", () => {
        expect(GLTF2.HasDefaultInteractivityFlowInput("flow/sequence")).toBe(true);
        expect(GLTF2.HasDefaultInteractivityFlowInput("flow/waitAll")).toBe(false);
        expect(GLTF2.HasDefaultInteractivityFlowInput("math/add")).toBe(false);
        expect(GLTF2.HasDefaultInteractivityFlowInput("flow/log:BABYLON")).toBe(true);

        expect(
            GLTF2.NormalizeInteractivityEventDataConfiguration({
                z: { type: { typeName: "number" }, value: { value: 3 } },
                a: { type: "boolean", value: [true] },
                malformed: 1,
            })
        ).toEqual([
            { id: "a", type: "boolean", value: [true] },
            { id: "malformed", malformed: true },
            { id: "z", type: "number", value: [3] },
        ]);
    });

    it("implements stable KHR_interactivity runtime value snapshots", () => {
        expect(GLTF2._NormalizeKHRInteractivityRuntimeValue({ asArray: () => new Float32Array([1, 2]) })).toEqual([1, 2]);
        expect(GLTF2._NormalizeKHRInteractivityRuntimeValue({ value: 3 })).toEqual([3]);
        expect(GLTF2._CreateKHRInteractivityRuntimeValueSnapshot({ b: -0, a: Number.NaN })).toEqual({
            runtimeValueFingerprint: '["array",[["object",[["a",["number","NaN"]],["b",["number","-0"]]]]]]',
        });

        const cyclic: { self?: unknown } = {};
        cyclic.self = cyclic;
        expect(GLTF2._CreateKHRInteractivityRuntimeValueSnapshot(cyclic)).toEqual({ unrepresentable: true });
    });

    it("exposes exporter symbols and names their structural blocker", () => {
        const diagnostics: GLTF2.IKHRInteractivityExportDiagnostic[] = [{ code: "GRAPH_SOURCE_MISSING", path: "/graphs/0", message: "missing", severity: "error" }];
        const error = new GLTF2.KHRInteractivityExportError(diagnostics);
        expect(error.name).toBe("KHRInteractivityExportError");
        expect(error.diagnostics).toBe(diagnostics);
        expect(error.message).toBe("/graphs/0: missing");

        expect(() => GLTF2.GetInteractivityOperationRegistry()).toThrow(/FlowGraph block/);
        expect(() => GLTF2._CaptureKHRInteractivityRuntimeInputDefaults({})).toThrow(/FlowGraph block/);
        expect(() => GLTF2.CreateKHRInteractivityExportPlan([])).toThrow(/glTF serializer/);
        expect(() => new GLTF2.KHRInteractivityExportPlan([])).toThrow(/glTF serializer/);
    });
});
