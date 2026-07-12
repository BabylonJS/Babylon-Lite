import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh";
import { updateMeshGeometry } from "../../../packages/babylon-lite/src/mesh/mesh-factories";

function fakeBuffer(): GPUBuffer {
    return {} as GPUBuffer;
}

function makeFixture(overrides: Partial<MeshGPU> = {}) {
    const buffers = {
        position: fakeBuffer(),
        normal: fakeBuffer(),
        index: fakeBuffer(),
        uv: fakeBuffer(),
        uv2: fakeBuffer(),
        tangent: fakeBuffer(),
        color: fakeBuffer(),
    };
    const gpu = {
        positionBuffer: buffers.position,
        normalBuffer: buffers.normal,
        indexBuffer: buffers.index,
        uvBuffer: buffers.uv,
        uv2Buffer: buffers.uv2,
        tangentBuffer: buffers.tangent,
        colorBuffer: buffers.color,
        indexCount: 3,
        indexFormat: "uint32",
        hasUv: true,
        hasUv2: true,
        hasTangent: true,
        hasColor: true,
        ...overrides,
    } satisfies MeshGPU;
    const originalPositions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const mesh = {
        _gpu: gpu,
        _cpuPositions: originalPositions,
        _cpuNormals: new Float32Array(9),
        _cpuUvs: new Float32Array(6),
        _cpuUv2s: new Float32Array(6),
        _cpuTangents: new Float32Array(12),
        _cpuColors: new Float32Array(12),
        _cpuIndices: new Uint32Array([0, 1, 2]),
    } as unknown as Mesh;
    const writeBuffer = vi.fn();
    const captureMesh = vi.fn();
    const engine = {
        _device: { queue: { writeBuffer } },
        _dlr: { m: captureMesh },
    } as unknown as EngineContext;
    return { buffers, gpu, mesh, originalPositions, writeBuffer, captureMesh, engine };
}

function replacementGeometry() {
    return {
        positions: new Float32Array([-2, -1, -3, 4, 5, 6, 1, 2, 3]),
        normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
        indices: new Uint32Array([2, 1, 0]),
        uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
        uvs2: new Float32Array([1, 1, 0, 1, 1, 0]),
        tangents: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
        colors: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]),
    };
}

describe("updateMeshGeometry", () => {
    it("updates all existing buffers and retained geometry without replacing GPU identities", () => {
        const { buffers, gpu, mesh, writeBuffer, captureMesh, engine } = makeFixture();
        const geometry = replacementGeometry();

        updateMeshGeometry(engine, mesh, geometry.positions, geometry.normals, geometry.indices, geometry.uvs, geometry.uvs2, geometry.tangents, geometry.colors);

        expect(mesh._gpu).toBe(gpu);
        expect(writeBuffer.mock.calls.map((call) => call[0])).toEqual([buffers.position, buffers.normal, buffers.index, buffers.uv, buffers.uv2, buffers.tangent, buffers.color]);
        expect(mesh.boundMin).toEqual([-2, -1, -3]);
        expect(mesh.boundMax).toEqual([4, 5, 6]);
        expect(mesh._cpuPositions).toBe(geometry.positions);
        expect(mesh._cpuNormals).toBe(geometry.normals);
        expect(mesh._cpuUvs).toBe(geometry.uvs);
        expect(mesh._cpuUv2s).toBe(geometry.uvs2);
        expect(mesh._cpuTangents).toBe(geometry.tangents);
        expect(mesh._cpuColors).toBe(geometry.colors);
        expect(mesh._cpuIndices).toBe(geometry.indices);
        expect(mesh._cpuGpuIndices).toBe(geometry.indices);
        expect(mesh._cpuIndexFormat).toBe("uint32");
        expect(captureMesh).toHaveBeenCalledWith(mesh, geometry.uvs2, geometry.tangents, geometry.colors, geometry.indices, "uint32");
    });

    it("rejects count and optional-layout changes before mutating CPU or GPU state", () => {
        const { mesh, originalPositions, writeBuffer, captureMesh, engine } = makeFixture();
        const geometry = replacementGeometry();

        expect(() => updateMeshGeometry(engine, mesh, geometry.positions.subarray(0, 6), geometry.normals.subarray(0, 6), geometry.indices, geometry.uvs.subarray(0, 4))).toThrow(
            "unchanged vertex/index counts"
        );
        expect(() =>
            updateMeshGeometry(engine, mesh, geometry.positions, geometry.normals, geometry.indices, undefined, geometry.uvs2, geometry.tangents, geometry.colors)
        ).toThrow("unchanged optional-attribute layout");

        expect(writeBuffer).not.toHaveBeenCalled();
        expect(captureMesh).not.toHaveBeenCalled();
        expect(mesh._cpuPositions).toBe(originalPositions);
    });

    it("rejects shared, interleaved, and non-uint32 geometry", () => {
        const geometry = replacementGeometry();
        const shared = makeFixture({ _refCount: 2 });
        const interleaved = makeFixture({ _vbLayout: { _p: { _stride: 12, _offset: 0 } } });
        const uint16 = makeFixture({ indexFormat: "uint16" });

        expect(() =>
            updateMeshGeometry(shared.engine, shared.mesh, geometry.positions, geometry.normals, geometry.indices, geometry.uvs, geometry.uvs2, geometry.tangents, geometry.colors)
        ).toThrow("unshared, tightly-packed");
        expect(() =>
            updateMeshGeometry(
                interleaved.engine,
                interleaved.mesh,
                geometry.positions,
                geometry.normals,
                geometry.indices,
                geometry.uvs,
                geometry.uvs2,
                geometry.tangents,
                geometry.colors
            )
        ).toThrow("unshared, tightly-packed");
        expect(() =>
            updateMeshGeometry(uint16.engine, uint16.mesh, geometry.positions, geometry.normals, geometry.indices, geometry.uvs, geometry.uvs2, geometry.tangents, geometry.colors)
        ).toThrow("unchanged vertex/index counts");
        expect(shared.writeBuffer).not.toHaveBeenCalled();
        expect(interleaved.writeBuffer).not.toHaveBeenCalled();
        expect(uint16.writeBuffer).not.toHaveBeenCalled();
    });
});
