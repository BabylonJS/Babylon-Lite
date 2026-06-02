import { describe, it, expect } from "vitest";
import { parseNodeMaterialSource, findBlockByClassName } from "../../../packages/babylon-lite/src/material/node/node-parser";
import { emitGraph, loadGraphEmitters } from "../../../packages/babylon-lite/src/material/node/node-emitter";

// End-to-end fixture: an `alpha` uniform + `uv` attribute go through a VectorMerger
// to produce vec4(uv.x, uv.y, 0, alpha) which is written to the fragment output.
const fixture = {
    blocks: [
        {
            customType: "BABYLON.InputBlock",
            id: 1,
            name: "uv",
            mode: 1, // Attribute
            type: 0x4, // Vector2
            inputs: [],
            outputs: [{ name: "output" }],
        },
        {
            customType: "BABYLON.InputBlock",
            id: 2,
            name: "alpha",
            mode: 0, // Uniform
            type: 0x1, // Float
            value: 1,
            inputs: [],
            outputs: [{ name: "output" }],
        },
        {
            customType: "BABYLON.VectorMergerBlock",
            id: 3,
            name: "merge",
            inputs: [
                { name: "xyzIn", targetBlockId: 1, targetConnectionName: "output" },
                { name: "w", targetBlockId: 2, targetConnectionName: "output" },
            ],
            outputs: [{ name: "xyzw" }, { name: "xyz" }, { name: "xy" }],
        },
        {
            customType: "BABYLON.FragmentOutputBlock",
            id: 4,
            name: "out",
            inputs: [{ name: "rgba", targetBlockId: 3, targetConnectionName: "xyzw" }],
            outputs: [],
        },
    ],
    outputNodes: [4],
};

describe("NodeMaterial emitter core", () => {
    it("compiles a 4-block graph to WGSL with correct UBO + attribute + varying decls", async () => {
        const graph = parseNodeMaterialSource(fixture);
        const emitters = await loadGraphEmitters(graph);
        const fragRoot = findBlockByClassName(graph, "FragmentOutputBlock")!;
        const result = emitGraph(graph, emitters, fragRoot.id, null);

        // UBO must contain the alpha uniform field.
        expect(result.state.nodeUboFields.find((f) => f._name === "alpha")).toBeTruthy();

        // Vertex attribute "uv" must be declared exactly once.
        expect(result.state.vertexAttributes.filter((a) => a._name === "uv")).toHaveLength(1);

        // A varying must bridge uv from vertex to fragment.
        expect(result.state.varyings.find((v) => v._name === "v_attr_uv")).toBeTruthy();

        // Fragment body must reference the uniform + varying and assign the output.
        expect(result.fragmentWgsl).toContain("nodeU.alpha");
        expect(result.fragmentWgsl).toContain("in.v_attr_uv");
        expect(result.fragmentWgsl).toContain("_NME_FRAG_OUTPUT_");

        // Vertex body must copy uv into the varying.
        expect(result.vertexWgsl).toContain("out.v_attr_uv = in.uv;");
    });

    it("memoizes shared subexpressions — emits each input once per stage", async () => {
        // uniform `c` feeds two fragment consumers via merge's x and y inputs.
        const shared = {
            blocks: [
                {
                    customType: "BABYLON.InputBlock",
                    id: 1,
                    name: "c",
                    mode: 0,
                    type: 0x1,
                    value: 0.5,
                    inputs: [],
                    outputs: [{ name: "output" }],
                },
                {
                    customType: "BABYLON.VectorMergerBlock",
                    id: 2,
                    name: "merge",
                    inputs: [
                        { name: "x", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "y", targetBlockId: 1, targetConnectionName: "output" },
                    ],
                    outputs: [{ name: "xyzw" }],
                },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 3,
                    name: "out",
                    inputs: [{ name: "rgba", targetBlockId: 2, targetConnectionName: "xyzw" }],
                    outputs: [],
                },
            ],
            outputNodes: [3],
        };
        const graph = parseNodeMaterialSource(shared);
        const emitters = await loadGraphEmitters(graph);
        const fragRoot = findBlockByClassName(graph, "FragmentOutputBlock")!;
        const result = emitGraph(graph, emitters, fragRoot.id, null);
        // The `c` uniform field appears exactly once in the UBO fields list.
        expect(result.state.nodeUboFields.filter((f) => f._name === "c")).toHaveLength(1);
    });

    it("casts vec4 to vec3 via .xyz when needed", async () => {
        const g = {
            blocks: [
                {
                    customType: "BABYLON.InputBlock",
                    id: 1,
                    name: "color",
                    mode: 0,
                    type: 0x10, // Vec4
                    inputs: [],
                    outputs: [{ name: "output" }],
                },
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
        const graph = parseNodeMaterialSource(g);
        const emitters = await loadGraphEmitters(graph);
        const fragRoot = findBlockByClassName(graph, "FragmentOutputBlock")!;
        const result = emitGraph(graph, emitters, fragRoot.id, null);
        expect(result.fragmentWgsl).toMatch(/\(nodeU\.color\)\.xyz/);
    });

    it("exposes NodeMaterial fragment coordinate depth in logical standard-Z space", async () => {
        const graph = parseNodeMaterialSource({
            blocks: [
                {
                    customType: "BABYLON.FragCoordBlock",
                    id: 1,
                    name: "FragCoord",
                    inputs: [],
                    outputs: [{ name: "z" }],
                },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 2,
                    name: "out",
                    inputs: [{ name: "rgb", targetBlockId: 1, targetConnectionName: "z" }],
                    outputs: [],
                },
            ],
            outputNodes: [2],
        });
        const emitters = await loadGraphEmitters(graph);
        const result = emitGraph(graph, emitters, 2, null);

        expect(result.fragmentWgsl).toContain("1.0 - _NME_FRAG_COORD_.z");
    });

    it("converts direct NodeMaterial FragDepthBlock depth inputs to reverse-Z writes", async () => {
        const graph = parseNodeMaterialSource({
            blocks: [
                {
                    customType: "BABYLON.InputBlock",
                    id: 1,
                    name: "depth",
                    mode: 0,
                    type: 0x1,
                    value: 0.5,
                    inputs: [],
                    outputs: [{ name: "output" }],
                },
                {
                    customType: "BABYLON.FragDepthBlock",
                    id: 2,
                    name: "FragDepth",
                    inputs: [{ name: "depth", targetBlockId: 1, targetConnectionName: "output" }],
                    outputs: [],
                },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 3,
                    name: "out",
                    inputs: [],
                    outputs: [],
                },
            ],
            outputNodes: [2, 3],
        });
        const emitters = await loadGraphEmitters(graph);
        const result = emitGraph(graph, emitters, 3, null);

        expect(result.state.usesFragDepth).toBe(true);
        expect(result.fragmentWgsl).toContain("_NME_FRAG_DEPTH_ = 1.0 - (nodeU.depth);");
    });
});
