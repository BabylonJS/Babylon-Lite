import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("runs real Navcat queries through the root API without WebGPU", async () => {
    const globals = globalThis as Record<string, unknown>;
    for (const key of ["GPUShaderStage", "GPUTextureUsage", "GPUBufferUsage", "GPUColorWrite"]) {
        delete globals[key];
    }
    expect(globals.GPUBufferUsage).toBeUndefined();
    const api = await import("../../../packages/babylon-lite/src/index.js");
    const json = readFileSync(new URL("../../../lab/public/navcat/demo-navmesh.json", import.meta.url), "utf8");
    const manager = await api.createNavcatManager(json);
    const path = api.findNavcatPath(manager, { x: -4, y: 0, z: 2 }, { x: 4, y: 0, z: -2 });
    expect(path.success && path.complete).toBe(true);
    api.disposeNavcatManager(manager);
    expect(() => api.findNavcatNearestPoly(manager, { x: 0, y: 0, z: 0 })).toThrow("disposed");
});
