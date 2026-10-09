import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { _rebuildMeshes } from "../../../packages/babylon-lite/src/engine/recovery-rebuild";
import { createMeshFromData, resizeMeshGeometry, setMeshDrawRange, updateMeshGeometry, updateMeshGeometryCapacity } from "../../../packages/babylon-lite/src/mesh/mesh-factories";
import { getMeshGeometry } from "../../../packages/babylon-lite/src/mesh/get-mesh-geometry";
import { writeMeshIndexedIndirectArgs } from "../../../packages/babylon-lite/src/mesh/mesh-indexed-indirect";
import { cloneTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { pickWithRay } from "../../../packages/babylon-lite/src/picking/ray-pick";
import { pickWithRayPrecise } from "../../../packages/babylon-lite/src/picking/precise-ray-pick";
import type { Ray } from "../../../packages/babylon-lite/src/picking/ray";

function fixture(indices = new Uint32Array([0, 1, 2, 0, 2, 3])) {
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => {
        const bytes = new ArrayBuffer(Number(descriptor.size));
        return { size: bytes.byteLength, getMappedRange: () => bytes, unmap: vi.fn(), destroy: vi.fn() } as unknown as GPUBuffer;
    });
    const writeBuffer = vi.fn();
    const scene = { meshes: [], _kind: "scene", _renderableVersion: 0 } as unknown as SceneContext;
    const engine = { _device: { createBuffer, queue: { writeBuffer } }, _renderingContexts: [scene] } as unknown as EngineContext;
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 10, 0]);
    const normals = new Float32Array(12);
    const mesh = createMeshFromData(engine, "card", positions, normals, indices);
    scene.meshes.push(mesh);
    createBuffer.mockClear();
    return { engine, scene, mesh, positions, normals, indices, createBuffer, writeBuffer };
}

const triangle = { vertices: { offset: 0, count: 3 }, indices: { offset: 0, count: 3 } } as const;

describe("setMeshDrawRange", () => {
    it("exposes active counts through a readonly accessor without replacing geometry", () => {
        const f = fixture();
        const gpu = f.mesh._gpu;
        setMeshDrawRange(f.engine, f.mesh, triangle);
        const descriptor = Object.getOwnPropertyDescriptor(gpu, "indexCount");
        expect(typeof descriptor?.get).toBe("function");
        expect(descriptor?.set).toBeUndefined();
        expect(descriptor?.writable).toBeUndefined();
        expect(gpu.indexCount).toBe(3);
        updateMeshGeometry(f.engine, f.mesh, f.positions, f.normals, f.indices);
        expect(gpu.indexCount).toBe(6);
        expect(f.mesh._gpu).toBe(gpu);
    });

    it("keeps independently recovered clone selections isolated", async () => {
        const f = fixture();
        setMeshDrawRange(f.engine, f.mesh, triangle);
        const clone = cloneTransformNode(f.mesh) as typeof f.mesh;
        f.scene.meshes.push(clone);
        await _rebuildMeshes(f.engine, f.scene);
        expect(clone._gpu).not.toBe(f.mesh._gpu);
        setMeshDrawRange(f.engine, f.mesh, { vertices: { offset: 0, count: 4 }, indices: { offset: 0, count: 6 } });
        expect(f.mesh._gpu.indexCount).toBe(6);
        expect(clone._gpu.indexCount).toBe(3);
        setMeshDrawRange(f.engine, clone, { vertices: { offset: 0, count: 0 }, indices: { offset: 0, count: 0 } });
        expect(clone._gpu.indexCount).toBe(0);
        expect(f.mesh._gpu.indexCount).toBe(6);
    });

    it("submits exact active counts without uploads or allocation and preserves legacy capacity behavior", () => {
        const f = fixture();
        updateMeshGeometryCapacity(f.engine, f.mesh, f.positions.subarray(0, 9), f.normals.subarray(0, 9), f.indices.subarray(0, 3), undefined, undefined, undefined, undefined, 1);
        expect(f.mesh._gpu.indexCount).toBe(6);
        f.writeBuffer.mockClear();
        const gpu = f.mesh._gpu;
        setMeshDrawRange(f.engine, f.mesh, triangle);
        expect(gpu.indexCount).toBe(3);
        expect(f.mesh._gpu).toBe(gpu);
        expect(f.createBuffer).not.toHaveBeenCalled();
        expect(f.writeBuffer).not.toHaveBeenCalled();
        expect(f.scene._renderableVersion).toBeGreaterThan(0);
    });

    it("shrinks, regrows and selects an empty range while keeping CPU snapshots independent", () => {
        const f = fixture();
        const gpu = f.mesh._gpu;
        setMeshDrawRange(f.engine, f.mesh, triangle);
        expect(getMeshGeometry(f.mesh)?.indices.length).toBe(3);
        expect(f.mesh.boundMax).toEqual([1, 1, 0]);
        expect(pickWithRay(f.scene, { origin: [10, 10, -1], direction: [0, 0, 1], length: 10 }).hit).toBe(false);
        const snapshot = getMeshGeometry(f.mesh)!;
        snapshot.positions.fill(999);
        expect(getMeshGeometry(f.mesh)?.positions[0]).toBe(0);
        const version = f.scene._renderableVersion;
        setMeshDrawRange(f.engine, f.mesh, triangle);
        expect(f.scene._renderableVersion).toBe(version);
        setMeshDrawRange(f.engine, f.mesh, { vertices: { offset: 0, count: 4 }, indices: { offset: 0, count: 6 } });
        expect(gpu.indexCount).toBe(6);
        expect(f.mesh.boundMax).toEqual([10, 10, 0]);
        expect(pickWithRay(f.scene, { origin: [10, 10, -1], direction: [0, 0, 1], length: 10 }).hit).toBe(true);
        setMeshDrawRange(f.engine, f.mesh, { vertices: { offset: 0, count: 4 }, indices: { offset: 6, count: 0 } });
        expect(gpu.indexCount).toBe(0);
        expect(f.mesh.boundMin).toBeUndefined();
        expect(pickWithRay(f.scene, { origin: [0, 0, -1], direction: [0, 0, 1], length: 10 }).hit).toBe(false);
        expect(f.mesh._gpu).toBe(gpu);
        expect(f.createBuffer).not.toHaveBeenCalled();
        expect(f.writeBuffer).not.toHaveBeenCalled();
    });

    it("supports odd point counts, independent offsets, and the indexed-indirect ABI", () => {
        const f = fixture(new Uint32Array([3, 0, 1, 2, 3]));
        setMeshDrawRange(f.engine, f.mesh, { vertices: { offset: 1, count: 3 }, indices: { offset: 1, count: 3 } });
        expect(getMeshGeometry(f.mesh)?.positions).toEqual(f.positions.subarray(3));
        expect(getMeshGeometry(f.mesh)?.indices).toEqual(new Uint32Array([0, 1, 2]));
        const args = new Uint32Array(5);
        writeMeshIndexedIndirectArgs(args, f.mesh._gpu, 2);
        expect(Array.from(args)).toEqual([3, 2, 1, 1, 0]);
        setMeshDrawRange(f.engine, f.mesh, { vertices: { offset: 0, count: 4 }, indices: { offset: 0, count: 5 } });
        expect(f.mesh._gpu.indexCount).toBe(5);
    });

    it.each([-1, 0.5, NaN, Infinity, 4294967296])("rejects invalid counts/offsets atomically (%s)", (value) => {
        const f = fixture();
        for (const range of [
            { vertices: { offset: value, count: 3 }, indices: triangle.indices },
            { vertices: { offset: 0, count: value }, indices: triangle.indices },
            { vertices: triangle.vertices, indices: { offset: value, count: 3 } },
            { vertices: triangle.vertices, indices: { offset: 0, count: value } },
        ]) {
            expect(() => setMeshDrawRange(f.engine, f.mesh, range)).toThrow();
        }
        expect(f.mesh._gpu.indexCount).toBe(6);
        expect(f.mesh._cpuPositions).toBe(f.positions);
        expect(f.scene._renderableVersion).toBe(0);
        expect(f.createBuffer).not.toHaveBeenCalled();
        expect(f.writeBuffer).not.toHaveBeenCalled();
    });

    it("rejects out-of-window indices and shared geometry without altering a clone", () => {
        const f = fixture();
        expect(() => setMeshDrawRange(f.engine, f.mesh, { vertices: triangle.vertices, indices: { offset: 0, count: 6 } })).toThrow("index");
        expect(() => setMeshDrawRange(f.engine, f.mesh, { vertices: { offset: 0, count: 0 }, indices: triangle.indices })).toThrow("index");
        setMeshDrawRange(f.engine, f.mesh, triangle);
        const clone = cloneTransformNode(f.mesh);
        expect(() => setMeshDrawRange(f.engine, f.mesh, { vertices: { offset: 0, count: 4 }, indices: { offset: 0, count: 6 } })).toThrow("unshared");
        expect(getMeshGeometry(f.mesh)?.indices.length).toBe(3);
        expect(clone).toHaveProperty("_gpu", f.mesh._gpu);
    });

    it("restores the full source and range after device loss, including regrowth from zero", async () => {
        const f = fixture(new Uint32Array([3, 0, 1, 2, 3]));
        setMeshDrawRange(f.engine, f.mesh, { vertices: { offset: 1, count: 3 }, indices: { offset: 1, count: 3 } });
        await _rebuildMeshes(f.engine, f.scene);
        expect(f.mesh._gpu.indexCount).toBe(3);
        expect(f.mesh._gpu._firstIndex).toBe(1);
        expect(f.mesh._gpu._baseVertex).toBe(1);
        expect(Array.from(new Float32Array(f.mesh._gpu.positionBuffer.getMappedRange(), 0, 12))).toEqual(Array.from(f.positions));
        setMeshDrawRange(f.engine, f.mesh, { vertices: { offset: 0, count: 0 }, indices: { offset: 0, count: 0 } });
        await _rebuildMeshes(f.engine, f.scene);
        setMeshDrawRange(f.engine, f.mesh, { vertices: { offset: 0, count: 4 }, indices: { offset: 0, count: 5 } });
        expect(f.mesh._gpu.indexCount).toBe(5);
    });

    it("clears an explicit range on complete geometry updates", () => {
        const f = fixture();
        setMeshDrawRange(f.engine, f.mesh, triangle);
        const version = f.scene._renderableVersion;
        updateMeshGeometry(f.engine, f.mesh, f.positions, f.normals, f.indices);
        expect(f.mesh._gpu.indexCount).toBe(6);
        expect(f.mesh._gpu._firstIndex ?? 0).toBe(0);
        expect(f.mesh._gpu._baseVertex ?? 0).toBe(0);
        expect(getMeshGeometry(f.mesh)?.positions.length).toBe(12);
        expect(f.scene._renderableVersion).toBeGreaterThan(version);
    });

    it("excludes inactive triangles from precise picking even when their vertices remain in the window", () => {
        const f = fixture();
        const ray: Ray = { origin: [5, 5, -1], direction: [0, 0, 1], length: 10 };
        expect(pickWithRayPrecise(f.scene, ray).hit).toBe(true);
        setMeshDrawRange(f.engine, f.mesh, { vertices: { offset: 0, count: 4 }, indices: { offset: 0, count: 3 } });
        expect(pickWithRayPrecise(f.scene, ray).hit).toBe(false);
        setMeshDrawRange(f.engine, f.mesh, { vertices: { offset: 0, count: 4 }, indices: { offset: 3, count: 3 } });
        expect(pickWithRayPrecise(f.scene, ray).hit).toBe(true);
    });

    it("selects all optional attributes and clears selections on capacity edits and resize", () => {
        const f = fixture();
        const uvs = new Float32Array(8).fill(1);
        const uvs2 = new Float32Array(8).fill(2);
        const tangents = new Float32Array(16).fill(3);
        const colors = new Float32Array(16).fill(4);
        const mesh = createMeshFromData(f.engine, "attributes", f.positions, f.normals, f.indices, uvs, uvs2, tangents, colors);
        setMeshDrawRange(f.engine, mesh, { vertices: { offset: 1, count: 3 }, indices: { offset: 0, count: 3 } });
        const geometry = getMeshGeometry(mesh)!;
        expect(geometry.uvs).toEqual(uvs.subarray(2));
        expect(geometry.uvs2).toEqual(uvs2.subarray(2));
        expect(geometry.tangents).toEqual(tangents.subarray(4));
        expect(geometry.colors).toEqual(colors.subarray(4));
        const version = f.scene._renderableVersion;
        updateMeshGeometryCapacity(f.engine, mesh, f.positions, f.normals, f.indices, uvs, uvs2, tangents, colors, 1);
        expect(mesh._gpu.indexCount).toBe(6);
        expect(mesh._gpu._baseVertex ?? 0).toBe(0);
        expect(getMeshGeometry(mesh)?.positions.length).toBe(12);
        expect(f.scene._renderableVersion).toBeGreaterThan(version);
        setMeshDrawRange(f.engine, mesh, triangle);
        const old = mesh._gpu;
        resizeMeshGeometry(f.engine, mesh, f.positions, f.normals, f.indices, uvs, uvs2, tangents, colors);
        expect(mesh._gpu).not.toBe(old);
        expect(mesh._gpu.indexCount).toBe(6);
        expect(mesh._gpu._drawRangeSource).toBeUndefined();
    });

    it("rejects borrowed, disposed, interleaved and unsupported index geometry", () => {
        for (const overrides of [{ _ownsVertexBuffers: false }, { _ownsIndexBuffer: false }, { _vbLayout: {} }, { indexFormat: "uint16" as const }]) {
            const f = fixture();
            Object.assign(f.mesh._gpu, overrides);
            expect(() => setMeshDrawRange(f.engine, f.mesh, triangle)).toThrow("requires");
            expect(f.createBuffer).not.toHaveBeenCalled();
            expect(f.writeBuffer).not.toHaveBeenCalled();
        }
        const disposed = fixture();
        disposed.mesh._disposed = true;
        expect(() => setMeshDrawRange(disposed.engine, disposed.mesh, triangle)).toThrow("live");
    });

    it("rejects missing CPU geometry and deformation before changing draw state", () => {
        const missing = fixture();
        missing.mesh._cpuNormals = undefined;
        expect(() => setMeshDrawRange(missing.engine, missing.mesh, triangle)).toThrow("retained CPU geometry");
        for (const field of ["skeleton", "morphTargets", "vat"] as const) {
            const f = fixture();
            Object.defineProperty(f.mesh, field, { value: {} });
            expect(() => setMeshDrawRange(f.engine, f.mesh, triangle)).toThrow("undeformed");
            expect(f.mesh._gpu.indexCount).toBe(6);
            expect(f.mesh._cpuPositions).toBe(f.positions);
            expect(f.createBuffer).not.toHaveBeenCalled();
            expect(f.writeBuffer).not.toHaveBeenCalled();
        }
    });
});
