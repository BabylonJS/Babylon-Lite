import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";

import { BUILD_LIB_DIR, cleanupTempDirs, ensureLibBuilt, runRollup } from "./bundler-harness";

const STATIC_GRAPH = {
    blocks: [
        { customType: "BABYLON.InputBlock", id: 1, name: "position", mode: 1, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
        {
            customType: "BABYLON.VertexOutputBlock",
            id: 2,
            name: "vertex",
            inputs: [{ name: "vector", targetBlockId: 1, targetConnectionName: "output" }],
            outputs: [],
        },
        { customType: "BABYLON.InputBlock", id: 3, name: "color", mode: 0, type: 0x8, value: [1, 1, 1], inputs: [], outputs: [{ name: "output" }] },
        {
            customType: "BABYLON.FragmentOutputBlock",
            id: 4,
            name: "fragment",
            inputs: [{ name: "rgb", targetBlockId: 3, targetConnectionName: "output" }],
            outputs: [],
        },
    ],
    outputNodes: [2, 4],
};

beforeAll(ensureLibBuilt);
afterAll(cleanupTempDirs);

describe("Node morph feature tree shaking", () => {
    it("keeps morph fallback and compiler code out of an actual static Node graph and normal renderer", async () => {
        const node = join(BUILD_LIB_DIR, "material/node");
        const result = await runRollup({
            entrySource: `
import { parseNodeMaterialFromSnippet } from ${JSON.stringify(join(node, "node-material.js"))};
import { buildNodeMeshRenderables } from ${JSON.stringify(join(node, "node-renderable.js"))};
console.log(parseNodeMaterialFromSnippet(globalThis.engine, "", { json: ${JSON.stringify(STATIC_GRAPH)} }), buildNodeMeshRenderables);
`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        const code = result.chunks!.find((chunk) => chunk.isEntry)!.code;
        expect(code).not.toContain("node-morph-empty");
        expect(code).not.toContain("morphDeltasUniforms");
        expect(code).not.toContain("fn nme_morph");
    });

    it("retains the complete feature when MorphTargetsBlock is imported", async () => {
        const result = await runRollup({
            entrySource: `import { emitter } from ${JSON.stringify(join(BUILD_LIB_DIR, "material/node/blocks/morph-targets.js"))}; console.log(emitter);`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        const code = result.chunks!.find((chunk) => chunk.isEntry)!.code;
        expect(code).toContain("node-morph-empty");
        expect(code).toContain("morphDeltasUniforms");
        expect(code).toContain("fn nme_morph");
        expect(code).toMatch(/morph\.weights\[i\]\s*\*\s*vec3<f32>/);
    });
});
