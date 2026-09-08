import { describe, expect, it, vi } from "vitest";

import type { MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh";

/**
 * A slab mesh addresses its slot through the draw call's `baseVertex` rather than a
 * non-zero `setVertexBuffer` bind offset. Every indexed draw that can be handed such a
 * mesh therefore has to pass it: the ShaderMaterial path honoured it, and PBR, Standard
 * and both picking paths silently drew slot 0.
 *
 * This reads the call sites rather than standing up four renderable pipelines, because
 * the property under test IS that no draw site forgets the argument. A behavioural test
 * per family would pass while a fifth site was added without it.
 */
const DRAW_SITES = [
    "packages/babylon-lite/src/material/pbr/pbr-renderable.ts",
    "packages/babylon-lite/src/material/pbr/pbr-geometry-renderable.ts",
    "packages/babylon-lite/src/material/standard/standard-renderable.ts",
    "packages/babylon-lite/src/material/standard/standard-geometry-renderable.ts",
    "packages/babylon-lite/src/material/shader/shader-thin-instance.ts",
    "packages/babylon-lite/src/picking/gpu-picker.ts",
    "packages/babylon-lite/src/picking/picking-advanced-draw.ts",
];

describe("baseVertex reaches every indexed draw", () => {
    it.each(DRAW_SITES)("%s passes _baseVertex to drawIndexed", async (file) => {
        const { readFileSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const source = readFileSync(resolve(process.cwd(), file), "utf8");

        const calls = source.split("\n").filter((line) => line.includes("drawIndexed(") && !line.includes("drawIndexedIndirect"));
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
            expect(call, `${file}: ${call.trim()}`).toMatch(/_baseVertex/);
        }
    });

    it("passes it in the fourth argument position, where WebGPU expects it", () => {
        // drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance).
        // A missed argument here draws the right slot from the wrong first index.
        const gpu = { indexCount: 3, _baseVertex: 8 } as unknown as MeshGPU;
        const drawIndexed = vi.fn();
        const pass = { drawIndexed } as unknown as GPURenderPassEncoder;

        pass.drawIndexed(gpu.indexCount, 1, 0, gpu._baseVertex);

        expect(drawIndexed).toHaveBeenCalledWith(3, 1, 0, 8);
    });

    it("is a no-op for an ordinary mesh, which has no slot", () => {
        // Undefined is WebIDL's default for the optional argument, which is why the field
        // can be passed unconditionally rather than branched on at every site.
        const gpu = { indexCount: 3 } as unknown as MeshGPU;
        expect(gpu._baseVertex).toBeUndefined();
    });
});
