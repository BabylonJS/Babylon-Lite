import { describe, it, expect } from "vitest";
import { parseNodeMaterialSource, topoSort, findBlockByClassName } from "../../../packages/babylon-lite/src/material/node/node-parser";

// Minimal fixture: UV attribute -> VectorMerger -> FragmentOutput
// uv attribute (xy) is combined with an input (z=0, w=1) and written out.
const fixture = {
    blocks: [
        {
            customType: "BABYLON.InputBlock",
            id: 1,
            name: "uv",
            mode: 1, // Attribute
            inputs: [],
            outputs: [{ name: "output" }],
        },
        {
            customType: "BABYLON.InputBlock",
            id: 2,
            name: "alpha",
            mode: 0, // Uniform
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
            outputs: [{ name: "xyzw" }],
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

describe("NodeMaterial parser", () => {
    it("parses blocks and strips BABYLON. prefix from customType", () => {
        const g = parseNodeMaterialSource(fixture);
        expect(g.blocks.size).toBe(4);
        expect(g.blocks.get(1)!.className).toBe("InputBlock");
        expect(g.blocks.get(4)!.className).toBe("FragmentOutputBlock");
    });

    it("resolves input -> source references", () => {
        const g = parseNodeMaterialSource(fixture);
        const merge = g.blocks.get(3)!;
        const xyzIn = merge.inputs.get("xyzIn")!;
        expect(xyzIn.source).toEqual({ blockId: 1, outputName: "output" });
    });

    it("surfaces uniform InputBlocks as named overridable inputs", () => {
        const g = parseNodeMaterialSource(fixture);
        // `uv` is mode=Attribute, should NOT be overridable
        expect(g.namedInputs.has("uv")).toBe(false);
        // `alpha` is mode=Uniform, should be overridable
        expect(g.namedInputs.get("alpha")).toBe(2);
    });

    it("topoSort emits producers before consumers", () => {
        const g = parseNodeMaterialSource(fixture);
        const order = topoSort(g, [4]);
        expect(order[order.length - 1]).toBe(4); // output last
        expect(order.indexOf(1)).toBeLessThan(order.indexOf(3));
        expect(order.indexOf(2)).toBeLessThan(order.indexOf(3));
        expect(order.indexOf(3)).toBeLessThan(order.indexOf(4));
    });

    it("topoSort throws on cycles", () => {
        const cyclic = {
            blocks: [
                {
                    customType: "BABYLON.A",
                    id: 1,
                    name: "a",
                    inputs: [{ name: "in", targetBlockId: 2, targetConnectionName: "out" }],
                    outputs: [{ name: "out" }],
                },
                {
                    customType: "BABYLON.B",
                    id: 2,
                    name: "b",
                    inputs: [{ name: "in", targetBlockId: 1, targetConnectionName: "out" }],
                    outputs: [{ name: "out" }],
                },
            ],
            outputNodes: [1],
        };
        const g = parseNodeMaterialSource(cyclic);
        expect(() => topoSort(g, [1])).toThrow(/cycle/);
    });

    it("findBlockByClassName returns the first match", () => {
        const g = parseNodeMaterialSource(fixture);
        expect(findBlockByClassName(g, "FragmentOutputBlock")!.id).toBe(4);
        expect(findBlockByClassName(g, "NonexistentBlock")).toBe(null);
    });

    it("rejects malformed source", () => {
        expect(() => parseNodeMaterialSource({})).toThrow(/blocks/);
        expect(() => parseNodeMaterialSource(null)).toThrow(/blocks/);
    });
});
