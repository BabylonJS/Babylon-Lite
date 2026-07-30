import { describe, expect, it } from "vitest";
import { mergeMeshGeometry } from "../../../packages/babylon-lite/src/mesh/merge-mesh-geometry";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";

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

function mirroredTriangle(): Mesh {
    return {
        name: "mirrored",
        _cpuPositions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        _cpuNormals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        _cpuIndices: new Uint32Array([0, 1, 2]),
        worldMatrix: new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    } as unknown as Mesh;
}

describe("mergeMeshGeometry", () => {
    it("reverses mirrored winding and keeps normals outward", () => {
        const merged = mergeMeshGeometry(fakeEngine(), "merged", [mirroredTriangle()]);

        expect(Array.from(merged._cpuPositions!)).toEqual([0, 0, 0, -1, 0, 0, 0, 1, 0]);
        expect(Array.from(merged._cpuIndices!)).toEqual([0, 2, 1]);
        expect(Array.from(merged._cpuNormals!)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    });
});
