import { describe, it, expect } from "vitest";
import { parseNodeMaterialSource, findBlockByClassName } from "../../packages/babylon-lite/src/material/node/node-parser";
import { emitGraph, loadGraphEmitters } from "../../packages/babylon-lite/src/material/node/node-emitter";

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
