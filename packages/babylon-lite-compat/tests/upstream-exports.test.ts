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

interface UpstreamMapping {
    blocks: string[];
    inputs?: {
        values?: Record<string, { name: string }>;
        flows?: Record<string, { name: string }>;
    };
}

interface UpstreamConnection {
    uniqueId: string;
    name: string;
    _connectionType: number;
    connectedPointIds: string[];
}

interface UpstreamBlock {
    className: string;
    type: string;
    config: unknown;
    uniqueId: string;
    dataInputs: UpstreamConnection[];
    dataOutputs: UpstreamConnection[];
    metadata: unknown;
    signalInputs: UpstreamConnection[];
    signalOutputs: UpstreamConnection[];
}

interface UpstreamContext {
    uniqueId: string;
    _userVariables: Record<string, unknown>;
    _connectionValues: Record<string, unknown>;
}

interface UpstreamParser {
    _animationTargetFps: number;
    getVariableName(index: number): string;
    serializeToFlowGraph(): {
        executionContexts: UpstreamContext[];
        allBlocks: UpstreamBlock[];
    };
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
        const extraProcessor = (
            _node: UpstreamNode,
            _declaration: { op: string },
            _mapping: UpstreamMapping,
            _parser: UpstreamParser,
            serializedObjects: UpstreamBlock[],
            _context: UpstreamContext,
            _gltf?: UpstreamGltf
        ): UpstreamBlock[] => serializedObjects;
        const mapping: IGLTFToFlowGraphMapping = {
            blocks: ["test"],
            interBlockConnectors: [{ input: "in", output: "out", inputBlockIndex: 0, outputBlockIndex: 1, isVariable: true }],
            validation,
            extraProcessor,
        };
        const connection: UpstreamConnection = {
            uniqueId: "connection",
            name: "value",
            _connectionType: 0,
            connectedPointIds: [],
        };
        const serialized = extraProcessor(
            { declaration: 0 },
            { op: "test" },
            mapping,
            {
                _animationTargetFps: 60,
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
