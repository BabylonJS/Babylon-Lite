import { describe, it, expect, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { parseNodeMaterialSource, findBlockByClassName } from "../../../packages/babylon-lite/src/material/node/node-parser";
import { emitGraph, loadGraphEmitters } from "../../../packages/babylon-lite/src/material/node/node-emitter";
import { createNodeLightingFeature } from "../../../packages/babylon-lite/src/material/node/node-lighting";
import { parseNodeMaterialFromSnippet } from "../../../packages/babylon-lite/src/material/node/node-material";
import { clearNodePipelineCache, compileNodePipeline } from "../../../packages/babylon-lite/src/material/node/node-pipeline";
import { loadBlockEmitter } from "../../../packages/babylon-lite/src/material/node/node-registry";
import type { BlockEmitter } from "../../../packages/babylon-lite/src/material/node/node-types";

function engineFixture(): EngineContext {
    const device = {
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
    } as unknown as GPUDevice;
    return { _device: device, format: "rgba8unorm", msaaSamples: 1 } as unknown as EngineContext;
}

async function compile(source: any, includeVertex = false) {
    const graph = parseNodeMaterialSource(source);
    const emitters = await loadGraphEmitters(graph);
    const fragRoot = findBlockByClassName(graph, "FragmentOutputBlock")!;
    const vertRoot = includeVertex ? findBlockByClassName(graph, "VertexOutputBlock") : null;
    const r = emitGraph(graph, emitters, fragRoot.id, vertRoot?.id ?? null);
    return r;
}

describe("NME lighting blocks", () => {
    it("LightBlock emits helper + call and exposes diffuse/specular outputs", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.InputBlock", id: 1, name: "wp", mode: 0, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 2, name: "wn", mode: 0, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 3, name: "dc", mode: 0, type: 0x20, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.LightBlock",
                    id: 4,
                    name: "lt",
                    inputs: [
                        { name: "worldPosition", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "worldNormal", targetBlockId: 2, targetConnectionName: "output" },
                        { name: "diffuseColor", targetBlockId: 3, targetConnectionName: "output" },
                    ],
                    outputs: [{ name: "diffuseOutput" }, { name: "specularOutput" }],
                },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 5,
                    name: "out",
                    inputs: [{ name: "rgb", targetBlockId: 4, targetConnectionName: "diffuseOutput" }],
                    outputs: [],
                },
            ],
            outputNodes: [5],
        };
        const r = await compile(g);
        // Helper is emitted in state.fragment.helpers, not in the body
        expect(r.state.fragment.helpers.has("nme_lighting")).toBe(true);
        expect(r.state.fragment.helpers.get("nme_lighting")).toContain("fn nme_computeLighting");
        expect(r.fragmentWgsl).toContain("nme_computeLighting(");
        // exactly one call in the body (helper signature is `fn nme_computeLighting(`)
        const calls = r.fragmentWgsl.match(/= nme_computeLighting\(/g) || [];
        expect(calls).toHaveLength(1);

        const compiled = compileNodePipeline(r.state, r.vertexWgsl, r.fragmentWgsl, {
            _engine: engineFixture(),
            _format: "rgba8unorm",
            _msaaSamples: 1,
        });
        expect(r.state._meshFeature).toBeTypeOf("function");
        expect(compiled._meshUboFloats).toBe(40);
        expect(compiled._writeMeshFeature).toBeTypeOf("function");
        expect(compiled._wgsl).toContain("    lc: u32,");
        expect(compiled._wgsl).toContain("    li: array<vec4<u32>, 4>,");
        expect(compiled._wgsl).toContain("fn nli(i: u32) -> u32");
        expect(compiled._wgsl).toContain("var<uniform> nmeLights: lightsUniforms;");
        const meshData = new Float32Array(40);
        compiled._writeMeshFeature!({ id: "mesh" } as never, [{ _writeLightUbo: vi.fn() }] as never, meshData);
        const meshWords = new Uint32Array(meshData.buffer);
        expect(meshWords[20]).toBe(1);
        expect(meshWords[24]).toBe(0);
        clearNodePipelineCache();
    });

    it("FogBlock injects fogFactor helper and mixes with fogColor", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.InputBlock", id: 1, name: "wp", mode: 0, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 2, name: "col", mode: 0, type: 0x20, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 3, name: "fc", mode: 0, type: 0x20, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.FogBlock",
                    id: 4,
                    name: "fog",
                    inputs: [
                        { name: "worldPosition", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "input", targetBlockId: 2, targetConnectionName: "output" },
                        { name: "fogColor", targetBlockId: 3, targetConnectionName: "output" },
                    ],
                    outputs: [{ name: "output" }],
                },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 5,
                    name: "out",
                    inputs: [{ name: "rgb", targetBlockId: 4, targetConnectionName: "output" }],
                    outputs: [],
                },
            ],
            outputNodes: [5],
        };
        const r = await compile(g);
        // Helper is emitted in state.fragment.helpers, not in the body
        expect(r.state.fragment.helpers.has("nme_fog")).toBe(true);
        expect(r.state.fragment.helpers.get("nme_fog")).toContain("fn nme_fogFactor");
        expect(r.fragmentWgsl).toMatch(/mix\(nodeU\.fc, nodeU\.col, nme_fogFactor/);
    });

    it("LightInformationBlock reads from mesh-selected nmeLights[i]", async () => {
        const g = {
            blocks: [
                {
                    customType: "BABYLON.LightInformationBlock",
                    id: 1,
                    name: "li",
                    lightId: 2,
                    inputs: [],
                    outputs: [{ name: "direction" }, { name: "color" }, { name: "intensity" }],
                },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 2,
                    name: "out",
                    inputs: [{ name: "rgb", targetBlockId: 1, targetConnectionName: "color" }],
                    outputs: [],
                },
            ],
            outputNodes: [2],
        };
        const r = await compile(g);
        expect(r.fragmentWgsl).toContain("nmeLights.lights[nli(2u)].vLightDiffuse.rgb");
    });

    it("preserves flag-only custom lighting emitter compatibility at the public parse boundary", async () => {
        const graph = {
            blocks: [
                { customType: "BABYLON.CustomLightBlock", id: 1, name: "custom", inputs: [], outputs: [{ name: "color" }] },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 2,
                    name: "out",
                    inputs: [{ name: "rgb", targetBlockId: 1, targetConnectionName: "color" }],
                    outputs: [],
                },
            ],
            outputNodes: [2],
        };
        const customLight: BlockEmitter = {
            className: "CustomLightBlock",
            emit(_block, _outputName, _stage, state) {
                state.usesLightsUbo = true;
                return { expr: "vec3<f32>(1.0)", type: "vec3f" };
            },
        };
        const blockLoader = async (className: string): Promise<BlockEmitter> => (className === "CustomLightBlock" ? customLight : loadBlockEmitter(className));

        const material = await parseNodeMaterialFromSnippet(engineFixture(), "", { json: graph, blockLoader });

        expect(material._state._meshFeature).toBe(createNodeLightingFeature);
        expect(material._compile._meshUboFloats).toBe(40);
        expect(material._compile._writeMeshFeature).toBeTypeOf("function");
        expect(material._compile._wgsl).toContain("var<uniform> nmeLights: lightsUniforms;");
        clearNodePipelineCache();
    });

    it("PerturbNormalBlock injects helper and strength default", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.InputBlock", id: 1, name: "wp", mode: 0, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 2, name: "wn", mode: 0, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 3, name: "uv", mode: 0, type: 0x4, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 4, name: "nm", mode: 0, type: 0x20, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.PerturbNormalBlock",
                    id: 5,
                    name: "pn",
                    inputs: [
                        { name: "worldPosition", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "worldNormal", targetBlockId: 2, targetConnectionName: "output" },
                        { name: "uv", targetBlockId: 3, targetConnectionName: "output" },
                        { name: "normalMapColor", targetBlockId: 4, targetConnectionName: "output" },
                    ],
                    outputs: [{ name: "output" }],
                },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 6,
                    name: "out",
                    inputs: [{ name: "rgb", targetBlockId: 5, targetConnectionName: "output" }],
                    outputs: [],
                },
            ],
            outputNodes: [6],
        };
        const r = await compile(g);
        // Helper is emitted in state.fragment.helpers, not in the body
        expect(r.state.fragment.helpers.has("nme_perturbNormal")).toBe(true);
        expect(r.state.fragment.helpers.get("nme_perturbNormal")).toContain("fn nme_perturbNormal");
        expect(r.fragmentWgsl).toMatch(/nme_perturbNormal\(nodeU\.wp, nodeU\.wn, nodeU\.uv, nodeU\.nm, 1\.0\)/);
    });
});
