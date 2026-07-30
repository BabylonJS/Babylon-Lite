import { describe, expect, it } from "vitest";
import type { EngineContext, Mesh as LiteMesh } from "babylon-lite";
import { mergeMeshGeometry } from "../src/meshes/merge-mesh-geometry.js";

function fakeEngine(): EngineContext {
    const createBuffer = (descriptor: GPUBufferDescriptor): GPUBuffer => {
        const storage = new ArrayBuffer(Number(descriptor.size));
        return {
            getMappedRange: () => storage,
            unmap: () => undefined,
            destroy: () => undefined,
        } as unknown as GPUBuffer;
    };
    return {
        _device: { createBuffer } as unknown as GPUDevice,
    } as unknown as EngineContext;
}

function mirroredTriangle(): LiteMesh {
    return {
        name: "mirrored",
        _cpuPositions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        _cpuNormals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        _cpuIndices: new Uint32Array([0, 1, 2]),
        worldMatrix: new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    } as unknown as LiteMesh;
}

describe("mergeMeshGeometry", () => {
    it("reverses mirrored winding and keeps normals outward", () => {
        const merged = mergeMeshGeometry(fakeEngine(), "merged", [mirroredTriangle()]);

        expect(Array.from(merged._cpuPositions!)).toEqual([0, 0, 0, -1, 0, 0, 0, 1, 0]);
        expect(Array.from(merged._cpuIndices!)).toEqual([0, 2, 1]);
        for (const [index, expected] of [0, 0, 1, 0, 0, 1, 0, 0, 1].entries()) {
            expect(merged._cpuNormals![index]).toBeCloseTo(expected);
        }
    });
});
