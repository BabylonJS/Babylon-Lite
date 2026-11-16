/** Regression: the MeshLoD facade must import in an environment with NO WebGPU
 *  implementation (Node/SSR/Jest). Importing it must have no side effects and must
 *  not dereference WebGPU globals — those load only when loadMeshLoD is called and
 *  the runtime chunk is dynamically imported.
 *
 *  This file runs in the vitest "no-webgpu" project (setupFiles: []), so the
 *  WebGPU flag namespaces are genuinely absent, matching a real Node consumer. */

import { beforeAll, describe, expect, it } from "vitest";

describe("MeshLoD facade imports without WebGPU globals", () => {
    beforeAll(() => {
        const g = globalThis as Record<string, unknown>;
        delete g.GPUShaderStage;
        delete g.GPUTextureUsage;
        delete g.GPUBufferUsage;
        delete g.GPUColorWrite;
    });

    it("imports the facade without throwing", async () => {
        await expect(import("../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js")).resolves.toBeDefined();
    });

    it("exposes the public functions", async () => {
        const mod = await import("../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js");
        expect(typeof mod.loadMeshLoD).toBe("function");
        expect(typeof mod.createMeshLoDInstance).toBe("function");
        expect(typeof mod.addMeshLoDToScene).toBe("function");
        expect(typeof mod.disposeMeshLoDAsset).toBe("function");
        expect(typeof mod.isMeshLoDError).toBe("function");
    });

    it("validates options without a WebGPU device", async () => {
        const mod = await import("../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js");
        await expect(mod.loadMeshLoD({} as never, "asset.mlod", { maxConcurrentRequests: 0 })).rejects.toMatchObject({ code: "MLOD_INVALID_OPTION" });
    });
});
