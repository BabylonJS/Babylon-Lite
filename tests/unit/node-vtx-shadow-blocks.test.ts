import { describe, it, expect } from "vitest";
import { parseNodeMaterialSource, findBlockByClassName } from "../../packages/babylon-lite/src/material/node/node-parser";
import { emitGraph, loadGraphEmitters } from "../../packages/babylon-lite/src/material/node/node-emitter";

async function compile(source: any, vertex = false, meshCaps?: { hasSkeleton?: boolean; hasInstances?: boolean }) {
    const graph = parseNodeMaterialSource(source);
    const emitters = await loadGraphEmitters(graph);
    const fragRoot = findBlockByClassName(graph, "FragmentOutputBlock")!;
    const vertRoot = vertex ? findBlockByClassName(graph, "VertexOutputBlock") : null;
    return emitGraph(graph, emitters, fragRoot.id, vertRoot?.id ?? null, undefined, meshCaps);
}

describe("NME vertex-transform & shadow blocks", () => {
    it("InstancesBlock emits the _NME_WORLD_MATRIX_ sentinel", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.InstancesBlock", id: 1, name: "inst", inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 2, name: "position", mode: 1, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.TransformBlock",
                    id: 3,
                    name: "xform",
                    inputs: [
                        { name: "vector", targetBlockId: 2, targetConnectionName: "output" },
                        { name: "transform", targetBlockId: 1, targetConnectionName: "output" },
                    ],
                    outputs: [{ name: "output" }],
                },
                {
                    customType: "BABYLON.VertexOutputBlock",
                    id: 4,
                    name: "vout",
                    inputs: [{ name: "vector", targetBlockId: 3, targetConnectionName: "output" }],
                    outputs: [],
                },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 5,
                    name: "out",
                    inputs: [{ name: "rgb", targetBlockId: 2, targetConnectionName: "output" }],
                    outputs: [],
                },
            ],
            outputNodes: [5],
        };
        const r = await compile(g, true);
        expect(r.vertexWgsl).toContain("meshU.world");
    });

    it("BonesBlock injects skinning helper", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.InputBlock", id: 1, name: "matricesIndices", mode: 1, type: 0x10, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 2, name: "matricesWeights", mode: 1, type: 0x10, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 3, name: "world", mode: 0, type: 0x80, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.BonesBlock",
                    id: 4,
                    name: "bones",
                    inputs: [
                        { name: "matricesIndices", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "matricesWeights", targetBlockId: 2, targetConnectionName: "output" },
                        { name: "world", targetBlockId: 3, targetConnectionName: "output" },
                    ],
                    outputs: [{ name: "output" }],
                },
                { customType: "BABYLON.InputBlock", id: 5, name: "position", mode: 1, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.TransformBlock",
                    id: 6,
                    name: "xform",
                    inputs: [
                        { name: "vector", targetBlockId: 5, targetConnectionName: "output" },
                        { name: "transform", targetBlockId: 4, targetConnectionName: "output" },
                    ],
                    outputs: [{ name: "output" }],
                },
                {
                    customType: "BABYLON.VertexOutputBlock",
                    id: 7,
                    name: "vout",
                    inputs: [{ name: "vector", targetBlockId: 6, targetConnectionName: "output" }],
                    outputs: [],
                },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 8,
                    name: "out",
                    inputs: [{ name: "rgb", targetBlockId: 5, targetConnectionName: "output" }],
                    outputs: [],
                },
            ],
            outputNodes: [8],
        };
        const r = await compile(g, true, { hasSkeleton: true });
        // Helper is emitted in state.vertex.helpers, not in the body
        expect(r.state.vertex.helpers.has("nme_skinning")).toBe(true);
        expect(r.state.vertex.helpers.get("nme_skinning")).toContain("fn nme_skinningMatrix");
        // Call appears in the vertex body via TransformBlock → VertexOutput
        expect(r.vertexWgsl).toContain("nme_skinningMatrix(");
    });

    it("MorphTargetsBlock emits _NME_MORPH_APPLY_ sentinel per output", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.InputBlock", id: 1, name: "position", mode: 1, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.MorphTargetsBlock",
                    id: 2,
                    name: "morph",
                    inputs: [{ name: "position", targetBlockId: 1, targetConnectionName: "output" }],
                    outputs: [{ name: "positionOutput" }],
                },
                { customType: "BABYLON.InputBlock", id: 3, name: "world", mode: 0, type: 0x80, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.TransformBlock",
                    id: 4,
                    name: "xform",
                    inputs: [
                        { name: "vector", targetBlockId: 2, targetConnectionName: "positionOutput" },
                        { name: "transform", targetBlockId: 3, targetConnectionName: "output" },
                    ],
                    outputs: [{ name: "output" }],
                },
                {
                    customType: "BABYLON.VertexOutputBlock",
                    id: 5,
                    name: "vout",
                    inputs: [{ name: "vector", targetBlockId: 4, targetConnectionName: "output" }],
                    outputs: [],
                },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 6,
                    name: "out",
                    inputs: [{ name: "rgb", targetBlockId: 1, targetConnectionName: "output" }],
                    outputs: [],
                },
            ],
            outputNodes: [6],
        };
        const r = await compile(g, true);
        expect(r.vertexWgsl).toContain("nme_morphPosition(in.position, vertexIndex)");
    });

    it("ShadowMapBlock emits shadow sentinel keyed by lightId", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.ShadowMapBlock", id: 1, name: "sm", lightId: 3, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 2,
                    name: "out",
                    inputs: [{ name: "rgb", targetBlockId: 1, targetConnectionName: "output" }],
                    outputs: [],
                },
            ],
            outputNodes: [2],
        };
        const r = await compile(g);
        expect(r.fragmentWgsl).toContain("_NME_SHADOW_3_");
    });
});
