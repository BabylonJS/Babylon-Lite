import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rollup } from "rollup";
import { cleanupTempDirs, ensureLibBuilt, isExternalRequest, LIB_ENTRY, makeTempEntry } from "./bundler-harness.js";

// Include the real bundled Navcat/mathcat SDK, rather than treating this vendor as a mock.
async function bundle(source: string): Promise<string> {
    const build = await rollup({
        input: makeTempEntry(source),
        external: (id) => isExternalRequest(id) && !/[\\/]_chunks[\\/]vendor[\\/]navcat/.test(id),
        treeshake: { moduleSideEffects: false },
        onwarn(warning) {
            if (warning.code !== "CIRCULAR_DEPENDENCY") {
                throw new Error(warning.message);
            }
        },
    });
    try {
        const result = await build.generate({ format: "es", inlineDynamicImports: true });
        return result.output
            .filter((item) => item.type === "chunk")
            .map((item) => item.code)
            .join("\n");
    } finally {
        await build.close();
    }
}

beforeAll(ensureLibBuilt);
afterAll(cleanupTempDirs);

describe("Navcat shipped-library optional boundaries", () => {
    it("eliminates the entire backend for an unrelated root consumer", async () => {
        const code = await bundle(`import { srgbByteToLinear } from ${JSON.stringify(LIB_ENTRY)}; export const exercise = srgbByteToLinear;`);
        expect(code).toContain("srgbByteToLinear");
        expect(code).not.toMatch(/createNavcatManager|findNearestPoly|generateSoloNavMesh|navcat-runtime/);
    });

    it("executes real queries without generation/crowd/Recast/Wasm or an external SDK import", async () => {
        const code = await bundle(`import { createNavcatManager, findNavcatPath, disposeNavcatManager } from ${JSON.stringify(LIB_ENTRY)};
export async function exercise(json) { const manager = await createNavcatManager(json); const path = findNavcatPath(manager,{x:-4,y:0,z:2},{x:4,y:0,z:-2}); disposeNavcatManager(manager); return path; }`);
        expect(code).toContain("findNearestPoly");
        expect(code).not.toMatch(/generateSoloNavMesh|rasterizeTriangles|createHeightfield|createCrowd|CrowdAgent|@recast-navigation|WebAssembly|from ["'](?:navcat|mathcat)/);
        const json = readFileSync(new URL("../../../lab/public/navcat/demo-navmesh.json", import.meta.url), "utf8");
        const api = (await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
            exercise: (input: string) => Promise<{ success: boolean; complete: boolean; points: { position: { z: number } }[] }>;
        };
        const result = await api.exercise(json);
        expect(result.success && result.complete).toBe(true);
        expect(result.points[0]!.position.z).toBe(2);
        expect(result.points.at(-1)!.position.z).toBe(-2);
    });

    it("positive control retains and executes solo generation only when requested", async () => {
        const code = await bundle(`import { generateNavcatMesh } from ${JSON.stringify(LIB_ENTRY)}; export const exercise = generateNavcatMesh;`);
        expect(code).toContain("generateSoloNavMesh");
        expect(code).toContain("rasterizeTriangles");
        const api = (await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
            exercise: (geometry: { positions: Float64Array; indices: Uint32Array }) => Promise<string>;
        };
        const json = await api.exercise({ positions: new Float64Array([-6, 0, -4, 6, 0, -4, 6, 0, 4, -6, 0, 4]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]) });
        expect((JSON.parse(json) as { nodes: unknown[] }).nodes.length).toBeGreaterThan(0);
    });
});
