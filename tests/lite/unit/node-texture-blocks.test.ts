import { describe, it, expect } from "vitest";
import { parseNodeMaterialSource, findBlockByClassName } from "../../../packages/babylon-lite/src/material/node/node-parser";
import { emitGraph, loadGraphEmitters } from "../../../packages/babylon-lite/src/material/node/node-emitter";

describe("NME texture / utility blocks", () => {
    it("TextureBlock emits textureSample with binding named after source ImageSourceBlock", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.InputBlock", id: 1, name: "uv", mode: 1, type: 0x4, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.ImageSourceBlock", id: 2, name: "albedo", inputs: [], outputs: [{ name: "source" }] },
                {
                    customType: "BABYLON.TextureBlock",
                    id: 3,
                    name: "tex",
                    inputs: [
                        { name: "uv", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "source", targetBlockId: 2, targetConnectionName: "source" },
                    ],
                    outputs: [{ name: "rgba" }, { name: "r" }],
                },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 4,
                    name: "out",
                    inputs: [{ name: "rgba", targetBlockId: 3, targetConnectionName: "rgba" }],
                    outputs: [],
                },
            ],
            outputNodes: [4],
        };
        const graph = parseNodeMaterialSource(g as any);
        const emitters = await loadGraphEmitters(graph);
        const fragRoot = findBlockByClassName(graph, "FragmentOutputBlock")!;
        const r = emitGraph(graph, emitters, fragRoot.id, null);

        // Binding comes from the ImageSourceBlock name ("albedo"), not the TextureBlock ("tex").
        expect(r.state.textures.find((t) => t.name === "albedo")).toBeTruthy();
        expect(r.fragmentWgsl).toContain("textureSample(nodeTex_albedo, nodeSamp_albedo, in.v_attr_uv)");
        expect(r.fragmentWgsl).toContain("_NME_FRAG_OUTPUT_");
    });

    it("TextureBlock shares one sample across rgba + r outputs (memoization)", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.InputBlock", id: 1, name: "uv", mode: 1, type: 0x4, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.TextureBlock",
                    id: 2,
                    name: "tex",
                    inputs: [{ name: "uv", targetBlockId: 1, targetConnectionName: "output" }],
                    outputs: [{ name: "rgba" }, { name: "r" }],
                },
                // ColorSplitter reads rgba.
                {
                    customType: "BABYLON.ColorSplitterBlock",
                    id: 3,
                    name: "split",
                    inputs: [{ name: "rgba", targetBlockId: 2, targetConnectionName: "rgba" }],
                    outputs: [{ name: "rgb" }],
                },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 4,
                    name: "out",
                    inputs: [
                        { name: "rgb", targetBlockId: 3, targetConnectionName: "rgb" },
                        { name: "a", targetBlockId: 2, targetConnectionName: "r" },
                    ],
                    outputs: [],
                },
            ],
            outputNodes: [4],
        };
        const graph = parseNodeMaterialSource(g as any);
        const emitters = await loadGraphEmitters(graph);
        const fragRoot = findBlockByClassName(graph, "FragmentOutputBlock")!;
        const r = emitGraph(graph, emitters, fragRoot.id, null);
        // The textureSample call should appear exactly once in the fragment body.
        const matches = r.fragmentWgsl.match(/textureSample/g) || [];
        expect(matches).toHaveLength(1);
    });

    it("FrontFacingBlock references the _NME_FRONT_FACING_ builtin sentinel", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.FrontFacingBlock", id: 1, name: "ff", inputs: [], outputs: [{ name: "output" }] },
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
        const graph = parseNodeMaterialSource(g as any);
        const emitters = await loadGraphEmitters(graph);
        const fragRoot = findBlockByClassName(graph, "FragmentOutputBlock")!;
        const r = emitGraph(graph, emitters, fragRoot.id, null);
        expect(r.fragmentWgsl).toContain("select(0.0, 1.0, _NME_FRONT_FACING_)");
    });

    it("ViewDirectionBlock computes normalize(cam - pos)", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.InputBlock", id: 1, name: "wp", mode: 0, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 2, name: "cp", mode: 0, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.ViewDirectionBlock",
                    id: 3,
                    name: "vd",
                    inputs: [
                        { name: "worldPosition", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "cameraPosition", targetBlockId: 2, targetConnectionName: "output" },
                    ],
                    outputs: [{ name: "output" }],
                },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 4,
                    name: "out",
                    inputs: [{ name: "rgb", targetBlockId: 3, targetConnectionName: "output" }],
                    outputs: [],
                },
            ],
            outputNodes: [4],
        };
        const graph = parseNodeMaterialSource(g as any);
        const emitters = await loadGraphEmitters(graph);
        const fragRoot = findBlockByClassName(graph, "FragmentOutputBlock")!;
        const r = emitGraph(graph, emitters, fragRoot.id, null);
        expect(r.fragmentWgsl).toMatch(/normalize\(nodeU\.cp - nodeU\.wp\)/);
    });
});
