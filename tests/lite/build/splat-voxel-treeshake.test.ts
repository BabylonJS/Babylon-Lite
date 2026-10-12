import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

beforeAll(ensureLibBuilt, 300_000);
afterAll(cleanupTempDirs);

describe("voxel collision opt-in boundary", () => {
    it("keeps standalone collision queries independent of the renderer and loader", async () => {
        const result = await runRollup({
            entrySource: `import { moveSplatVoxelCamera } from ${JSON.stringify(LIB_ENTRY)}; console.log(moveSplatVoxelCamera);`,
            format: "es",
            minify: false,
        });
        expect(result.errors).toEqual([]);
        expect(result.code).toContain("Collision motion and radius");
        expect(result.code).not.toContain("requestAdapter");
        expect(result.code).not.toContain("fetch(");
        expect(result.code).not.toContain("Invalid splat voxel collision data");
    });

    it("removes unused collision exports from a root import", async () => {
        const result = await runRollup({
            entrySource: `import { createFreeCamera } from ${JSON.stringify(LIB_ENTRY)}; console.log(createFreeCamera);`,
            format: "es",
            minify: false,
        });
        expect(result.errors).toEqual([]);
        expect(result.code).not.toContain("Collision motion and radius");
        expect(result.code).not.toContain("Invalid splat voxel collision data");
        expect(result.code).not.toContain("Collision URL must");
    });
});
