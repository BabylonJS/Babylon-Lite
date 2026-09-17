import { describe, expect, it } from "vitest";

import {
    BezierCurveEase,
    GLTF2,
    FlowGraphValidationSeverity,
    PowerEase,
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
    it("exposes Babylon.js Power and Bezier easing classes", () => {
        expect(new PowerEase(3).ease(0.5)).toBe(0.125);
        expect(new BezierCurveEase(0.42, 0, 0.58, 1).ease(0.5)).toBe(0.5);
    });

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
});
