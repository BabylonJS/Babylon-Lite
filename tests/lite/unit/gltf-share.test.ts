import { describe, expect, it, vi } from "vitest";

import { BU } from "../../../packages/babylon-lite/src/engine/gpu-flags.js";
import { U32 } from "../../../packages/babylon-lite/src/engine/typed-arrays.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types.js";
import { share } from "../../../packages/babylon-lite/src/loader-gltf/gltf-share.js";
import type { GltfLoadCtx } from "../../../packages/babylon-lite/src/loader-gltf/gltf-feature.js";
import type { GltfMaterialData } from "../../../packages/babylon-lite/src/loader-gltf/gltf-material.js";
import type { GltfMeshData } from "../../../packages/babylon-lite/src/loader-gltf/load-gltf.js";
import { disposeMeshGpu } from "../../../packages/babylon-lite/src/mesh/mesh-dispose.js";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { createMappedBuffer } from "../../../packages/babylon-lite/src/resource/gpu-buffers.js";

function makeEngine() {
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => {
        const storage = new ArrayBuffer(Number(descriptor.size));
        return {
            destroy: vi.fn(),
            getMappedRange: vi.fn(() => storage),
            unmap: vi.fn(),
        } as unknown as GPUBuffer;
    });
    return {
        createBuffer,
        engine: {
            _device: { createBuffer } as unknown as GPUDevice,
        } as unknown as EngineContext,
    };
}

function makeMeshData(nodeIndex: number, primitive: object, material: GltfMaterialData): GltfMeshData {
    return {
        _positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        _normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        _tangents: null,
        _uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
        _uv2s: null,
        _colors: null,
        _indices: new Uint16Array([0, 1, 2]),
        _vertexCount: 3,
        _indexCount: 3,
        _worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as unknown as Mat4,
        _material: material,
        _nodeIndex: nodeIndex,
        _primitive: primitive,
    };
}

function buildTightMesh(engine: EngineContext, meshData: GltfMeshData, material: PbrMaterialProps, name: string, source?: Mesh): Mesh {
    const gpu: MeshGPU =
        source?._gpu ??
        ({
            positionBuffer: createMappedBuffer(engine, meshData._positions!, BU.VERTEX),
            normalBuffer: createMappedBuffer(engine, meshData._normals!, BU.VERTEX),
            uvBuffer: createMappedBuffer(engine, meshData._uvs!, BU.VERTEX),
            indexBuffer: createMappedBuffer(engine, meshData._indices, BU.INDEX),
            indexCount: meshData._indexCount,
            indexFormat: "uint16",
        } satisfies MeshGPU);
    const mesh = {
        name,
        material,
        receiveShadows: false,
        _gpu: gpu,
    } as Mesh;
    mesh._cpuPositions = meshData._positions!;
    mesh._cpuNormals = meshData._normals!;
    mesh._cpuUvs = meshData._uvs!;
    mesh._cpuIndices = source?._cpuIndices ?? new U32(meshData._indices);
    return mesh;
}

describe("glTF geometry sharing scope", () => {
    it("does not retain an owner from an inactive glTF scene", async () => {
        const primitive = {};
        const material = {} as GltfMaterialData;
        const json = {
            scene: 0,
            scenes: [{ nodes: [0] }, { nodes: [1] }],
            nodes: [{ mesh: 0 }, { mesh: 0 }],
            meshes: [{ name: "shared", primitives: [primitive] }],
        };
        const { createBuffer, engine } = makeEngine();
        const ctx = { _engine: engine, _json: json } as unknown as GltfLoadCtx;
        const meshes = await share([makeMeshData(0, primitive, material), makeMeshData(1, primitive, material)], async () => ({}) as PbrMaterialProps, buildTightMesh, [], ctx);

        expect(meshes[1]!._gpu).not.toBe(meshes[0]!._gpu);
        expect(meshes[0]!._gpu._refCount).toBeUndefined();
        expect(meshes[1]!._gpu._refCount).toBeUndefined();
        expect(meshes[1]!._cpuPositions).not.toBe(meshes[0]!._cpuPositions);
        expect(createBuffer).toHaveBeenCalledTimes(8);

        const activeBuffers = [meshes[0]!._gpu.positionBuffer, meshes[0]!._gpu.normalBuffer, meshes[0]!._gpu.uvBuffer, meshes[0]!._gpu.indexBuffer];
        disposeMeshGpu(meshes[0]!);
        for (const buffer of activeBuffers) {
            expect(buffer.destroy).toHaveBeenCalledTimes(1);
        }
        expect(meshes[1]!._gpu.positionBuffer.destroy).not.toHaveBeenCalled();
    });
});
