import { describe, it, expect } from "vitest";
import { parseNodeMaterialSource, findBlockByClassName } from "../../packages/babylon-lite/src/material/node/node-parser";
import { emitGraph, loadGraphEmitters } from "../../packages/babylon-lite/src/material/node/node-emitter";

/** Build a simple graph: InputBlock(value, mode=0) -> block(op) -> FragmentOutput.rgb */
function makeUnaryGraph(blockType: string, inputType = 0x8 /* Vec3 */, extra: Record<string, unknown> = {}) {
    return {
        blocks: [
            {
                customType: "BABYLON.InputBlock",
                id: 1,
                name: "src",
                mode: 0,
                type: inputType,
                inputs: [],
                outputs: [{ name: "output" }],
            },
            {
                customType: `BABYLON.${blockType}`,
                id: 2,
                name: "op",
                ...extra,
                inputs: [{ name: "input", targetBlockId: 1, targetConnectionName: "output" }],
                outputs: [{ name: "output" }],
            },
            {
                customType: "BABYLON.FragmentOutputBlock",
                id: 3,
                name: "out",
                inputs: [{ name: "rgb", targetBlockId: 2, targetConnectionName: "output" }],
                outputs: [],
            },
        ],
        outputNodes: [3],
    };
}

/** Build a binary graph with a,b feeding op, then op.output -> FragmentOutput.rgb */
function makeBinaryGraph(blockType: string, leftName = "left", rightName = "right", leftType = 0x8, rightType = 0x8) {
    return {
        blocks: [
            { customType: "BABYLON.InputBlock", id: 1, name: "a", mode: 0, type: leftType, inputs: [], outputs: [{ name: "output" }] },
            { customType: "BABYLON.InputBlock", id: 2, name: "b", mode: 0, type: rightType, inputs: [], outputs: [{ name: "output" }] },
            {
                customType: `BABYLON.${blockType}`,
                id: 3,
                name: "op",
                inputs: [
                    { name: leftName, targetBlockId: 1, targetConnectionName: "output" },
                    { name: rightName, targetBlockId: 2, targetConnectionName: "output" },
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
}

async function compile(source: ReturnType<typeof makeUnaryGraph>) {
    const graph = parseNodeMaterialSource(source);
    const emitters = await loadGraphEmitters(graph);
    const fragRoot = findBlockByClassName(graph, "FragmentOutputBlock")!;
    return emitGraph(graph, emitters, fragRoot.id, null);
}

describe("NME math block emitters", () => {
    it("AddBlock emits `left + right`", async () => {
        const r = await compile(makeBinaryGraph("AddBlock") as any);
        expect(r.fragmentWgsl).toMatch(/nodeU\.a \+ nodeU\.b/);
    });

    it("MultiplyBlock widens scalar to vec3", async () => {
        const r = await compile(makeBinaryGraph("MultiplyBlock", "left", "right", 0x8 /* vec3 */, 0x1 /* scalar */) as any);
        expect(r.fragmentWgsl).toMatch(/nodeU\.a \* vec3<f32>\(nodeU\.b\)/);
    });

    it("OneMinusBlock emits `1.0 - v`", async () => {
        const r = await compile(makeUnaryGraph("OneMinusBlock") as any);
        expect(r.fragmentWgsl).toMatch(/1\.0 - nodeU\.src/);
    });

    it("NegateBlock emits `-v`", async () => {
        const g = makeUnaryGraph("NegateBlock");
        // NegateBlock uses input name "value" instead of "input"
        (g.blocks[1] as any).inputs = [{ name: "value", targetBlockId: 1, targetConnectionName: "output" }];
        const r = await compile(g as any);
        expect(r.fragmentWgsl).toMatch(/-nodeU\.src/);
    });

    it("NormalizeBlock wraps in normalize()", async () => {
        const r = await compile(makeUnaryGraph("NormalizeBlock") as any);
        expect(r.fragmentWgsl).toMatch(/normalize\(nodeU\.src\)/);
    });

    it("DotBlock returns scalar", async () => {
        const r = await compile(makeBinaryGraph("DotBlock") as any);
        expect(r.fragmentWgsl).toContain("dot(nodeU.a, nodeU.b)");
        // Result is scalar but feeds vec3 rgb input → widened to vec3
        expect(r.fragmentWgsl).toMatch(/vec3<f32>\(.*dot\(/);
    });

    it("ScaleBlock multiplies by scalar factor", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.InputBlock", id: 1, name: "v", mode: 0, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 2, name: "f", mode: 0, type: 0x1, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.ScaleBlock",
                    id: 3,
                    name: "s",
                    inputs: [
                        { name: "input", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "factor", targetBlockId: 2, targetConnectionName: "output" },
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
        const r = await compile(g as any);
        expect(r.fragmentWgsl).toMatch(/nodeU\.v \* nodeU\.f/);
    });

    it("ClampBlock uses serialized min/max", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.InputBlock", id: 1, name: "src", mode: 0, type: 0x1, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.ClampBlock",
                    id: 2,
                    name: "clamp",
                    minimum: 0.2,
                    maximum: 0.8,
                    inputs: [{ name: "value", targetBlockId: 1, targetConnectionName: "output" }],
                    outputs: [{ name: "output" }],
                },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 3,
                    name: "out",
                    inputs: [{ name: "rgb", targetBlockId: 2, targetConnectionName: "output" }],
                    outputs: [],
                },
            ],
            outputNodes: [3],
        };
        const r = await compile(g as any);
        expect(r.fragmentWgsl).toMatch(/clamp\(nodeU\.src, 0\.2, 0\.8\)/);
    });

    it("TrigonometryBlock maps operation index to WGSL fn", async () => {
        // op=1 → sin
        const r = await compile(makeUnaryGraph("TrigonometryBlock", 0x1, { operation: 1 }) as any);
        expect(r.fragmentWgsl).toMatch(/sin\(nodeU\.src\)/);
    });

    it("VectorSplitterBlock picks widest connected input and emits correct swizzle", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.InputBlock", id: 1, name: "v", mode: 0, type: 0x10 /* vec4 */, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.VectorSplitterBlock",
                    id: 2,
                    name: "split",
                    inputs: [{ name: "xyzw", targetBlockId: 1, targetConnectionName: "output" }],
                    outputs: [{ name: "xyz" }, { name: "y" }],
                },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 3,
                    name: "out",
                    inputs: [{ name: "rgb", targetBlockId: 2, targetConnectionName: "xyz" }],
                    outputs: [],
                },
            ],
            outputNodes: [3],
        };
        const r = await compile(g as any);
        expect(r.fragmentWgsl).toMatch(/\(nodeU\.v\)\.xyz/);
    });

    it("TransformBlock builds vec4(pos, complementW)", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.InputBlock", id: 1, name: "position", mode: 1, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 2, name: "wvp", mode: 0, type: 0x80 /* matrix */, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.TransformBlock",
                    id: 3,
                    name: "xform",
                    complementW: 1,
                    inputs: [
                        { name: "vector", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "transform", targetBlockId: 2, targetConnectionName: "output" },
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
                    name: "fout",
                    inputs: [{ name: "rgb", targetBlockId: 1, targetConnectionName: "output" }],
                    outputs: [],
                },
            ],
            outputNodes: [5],
        };
        const graph = parseNodeMaterialSource(g as any);
        const emitters = await loadGraphEmitters(graph);
        const fragRoot = findBlockByClassName(graph, "FragmentOutputBlock")!;
        const vertRoot = findBlockByClassName(graph, "VertexOutputBlock")!;
        const r = emitGraph(graph, emitters, fragRoot.id, vertRoot.id);
        expect(r.vertexWgsl).toMatch(/nodeU\.wvp \* vec4<f32>\(in\.position, 1\.0\)/);
        expect(r.vertexWgsl).toContain("_NME_VTX_OUTPUT_");
    });

    it("LerpBlock uses mix()", async () => {
        const g = {
            blocks: [
                { customType: "BABYLON.InputBlock", id: 1, name: "a", mode: 0, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 2, name: "b", mode: 0, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 3, name: "g", mode: 0, type: 0x1, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.LerpBlock",
                    id: 4,
                    name: "lerp",
                    inputs: [
                        { name: "left", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "right", targetBlockId: 2, targetConnectionName: "output" },
                        { name: "gradient", targetBlockId: 3, targetConnectionName: "output" },
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
        const r = await compile(g as any);
        expect(r.fragmentWgsl).toMatch(/mix\(nodeU\.a, nodeU\.b, vec3<f32>\(nodeU\.g\)\)/);
    });

    it("RemapBlock emits the remap formula", async () => {
        const r = await compile(
            makeUnaryGraph("RemapBlock", 0x1, {
                inputs: [{ name: "input", targetBlockId: 1, targetConnectionName: "output" }],
                "sourceRange.x": 0,
                "sourceRange.y": 1,
                "targetRange.x": -1,
                "targetRange.y": 1,
            }) as any
        );
        // Output: (-1.0 + (input - 0.0) * (1.0 - -1.0) / (1.0 - 0.0))
        expect(r.fragmentWgsl).toMatch(/-1\.0 \+ \(nodeU\.src - 0\.0\)/);
    });
});
