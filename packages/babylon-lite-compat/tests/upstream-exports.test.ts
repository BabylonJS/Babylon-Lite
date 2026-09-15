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
        const mapping: IGLTFToFlowGraphMapping = {
            blocks: ["test"],
            interBlockConnectors: [{ input: "in", output: "out", inputBlockIndex: 0, outputBlockIndex: 1, isVariable: true }],
            validation: () => ({ valid: false, error: "invalid" }),
            extraProcessor: (_node, _declaration, _mapping, _parser, serializedObjects) => serializedObjects,
        };

        expect(mapping.interBlockConnectors?.[0]?.outputBlockIndex).toBe(1);
        expect(mapping.validation?.({}, {})).toEqual({ valid: false, error: "invalid" });
    });
});
