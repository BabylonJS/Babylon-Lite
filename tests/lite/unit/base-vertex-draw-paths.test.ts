import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh";
import { writeMeshIndexedIndirectArgs } from "../../../packages/babylon-lite/src/mesh/mesh-indexed-indirect";
import { syncThinInstanceDrawArgs } from "../../../packages/babylon-lite/src/mesh/thin-instance-gpu";
import type { ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance";

const DIRECT_SITES = [
    "packages/babylon-lite/src/material/pbr/pbr-renderable.ts",
    "packages/babylon-lite/src/material/pbr/pbr-geometry-renderable.ts",
    "packages/babylon-lite/src/material/standard/standard-renderable.ts",
    "packages/babylon-lite/src/material/standard/standard-geometry-renderable.ts",
    "packages/babylon-lite/src/material/node/node-renderable.ts",
    "packages/babylon-lite/src/material/node/node-geometry-renderable.ts",
    "packages/babylon-lite/src/material/shader/shader-renderable.ts",
    "packages/babylon-lite/src/material/shader/shader-thin-instance.ts",
];

describe("baseVertex reaches every indexed draw path", () => {
    it.each(DIRECT_SITES)("%s passes mesh baseVertex directly to WebGPU", async (file) => {
        const { readFileSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const source = readFileSync(resolve(process.cwd(), file), "utf8");
        expect(source).toMatch(/pass\.drawIndexed\([^;\n]*,\s*0,\s*(?:g|gpu)\._baseVertex\)/);
    });

    it("writes baseVertex into indexed-indirect word 3", () => {
        const args = new Uint32Array(5);
        writeMeshIndexedIndirectArgs(args, { indexCount: 6, _baseVertex: 24 } as unknown as MeshGPU, 7);
        expect([...args]).toEqual([6, 7, 0, 24, 0]);
    });

    it("keeps stable thin-instance indirect arguments synchronized with the mesh slot", () => {
        const writeBuffer = vi.fn();
        const engine = {
            _device: {
                createBuffer: vi.fn(() => ({}) as GPUBuffer),
                queue: { writeBuffer },
            },
        } as unknown as EngineContext;
        const ti = { count: 5 } as ThinInstanceData;
        const gpu = { indexCount: 12, _baseVertex: 40 } as unknown as MeshGPU;

        syncThinInstanceDrawArgs(engine, ti, gpu);

        expect([...ti._drawArgsData!]).toEqual([12, 5, 0, 40, 0]);
        expect(writeBuffer).toHaveBeenCalledOnce();
    });

    it("uses the centralized indirect ABI for cached, culling, and LOD arguments", async () => {
        const { readFileSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        for (const file of ["packages/babylon-lite/src/mesh/thin-instance-gpu.ts", "packages/babylon-lite/src/mesh/thin-instance-gpu-culling.ts"]) {
            const source = readFileSync(resolve(process.cwd(), file), "utf8");
            expect(source).toContain("writeMeshIndexedIndirectArgs(");
        }
    });
});
