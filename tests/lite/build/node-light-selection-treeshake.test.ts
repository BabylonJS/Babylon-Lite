import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";

import { BUILD_LIB_DIR, cleanupTempDirs, ensureLibBuilt, runRollup } from "./bundler-harness";

beforeAll(ensureLibBuilt);
afterAll(cleanupTempDirs);

describe("Node light-selection tree shaking", () => {
    it("keeps mesh light-selection code out of the normal Node renderer", async () => {
        const node = join(BUILD_LIB_DIR, "material/node");
        const result = await runRollup({
            entrySource: `import { buildNodeMeshRenderables } from ${JSON.stringify(join(node, "node-renderable.js"))}; console.log(buildNodeMeshRenderables);`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        const code = result.chunks!.find((chunk) => chunk.isEntry)!.code;
        expect(code).not.toContain("function writeMeshLightSelection");
        expect(code).not.toContain("MSH_LIGHT_INDEX_WORD_OFFSET");
    });

    it("retains mesh light-selection code with a lighting block emitter", async () => {
        const result = await runRollup({
            entrySource: `import { emitter } from ${JSON.stringify(join(BUILD_LIB_DIR, "material/node/blocks/light-block.js"))}; console.log(emitter);`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        const code = result.chunks!.find((chunk) => chunk.isEntry)!.code;
        expect(code).toContain("function writeMeshLightSelection");
        expect(code).toContain("MSH_LIGHT_INDEX_WORD_OFFSET");
    });
});
