import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { loadGltf } from "../../../packages/babylon-lite/src/loader-gltf/load-gltf.js";
import { disposeMeshGpu } from "../../../packages/babylon-lite/src/mesh/mesh-dispose.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import type { TransformNode } from "../../../packages/babylon-lite/src/scene/transform-node.js";

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;

function align4(value: number): number {
    return (value + 3) & ~3;
}

function makeSharedMeshGlb(): ArrayBuffer {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
    const indices = new Uint16Array([0, 1, 2]);

    const positionOffset = 0;
    const normalOffset = positionOffset + positions.byteLength;
    const uvOffset = normalOffset + normals.byteLength;
    const indexOffset = uvOffset + uvs.byteLength;
    const binaryByteLength = indexOffset + indices.byteLength;
    const binary = new Uint8Array(align4(binaryByteLength));
    binary.set(new Uint8Array(positions.buffer), positionOffset);
    binary.set(new Uint8Array(normals.buffer), normalOffset);
    binary.set(new Uint8Array(uvs.buffer), uvOffset);
    binary.set(new Uint8Array(indices.buffer), indexOffset);

    const json = {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0, 1] }],
        nodes: [
            { name: "first", mesh: 0 },
            { name: "second", mesh: 0, translation: [10, 0, 0] },
        ],
        meshes: [
            {
                name: "shared",
                primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 }],
            },
        ],
        buffers: [{ byteLength: binaryByteLength }],
        bufferViews: [
            { buffer: 0, byteOffset: positionOffset, byteLength: positions.byteLength },
            { buffer: 0, byteOffset: normalOffset, byteLength: normals.byteLength },
            { buffer: 0, byteOffset: uvOffset, byteLength: uvs.byteLength },
            { buffer: 0, byteOffset: indexOffset, byteLength: indices.byteLength },
        ],
        accessors: [
            { bufferView: 0, componentType: FLOAT, count: 3, type: "VEC3" },
            { bufferView: 1, componentType: FLOAT, count: 3, type: "VEC3" },
            { bufferView: 2, componentType: FLOAT, count: 3, type: "VEC2" },
            { bufferView: 3, componentType: UNSIGNED_SHORT, count: 3, type: "SCALAR" },
        ],
    };

    const encodedJson = new TextEncoder().encode(JSON.stringify(json));
    const jsonByteLength = align4(encodedJson.byteLength);
    const totalByteLength = 12 + 8 + jsonByteLength + 8 + binary.byteLength;
    const glb = new ArrayBuffer(totalByteLength);
    const view = new DataView(glb);
    const bytes = new Uint8Array(glb);

    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, totalByteLength, true);
    view.setUint32(12, jsonByteLength, true);
    view.setUint32(16, 0x4e4f534a, true);
    bytes.fill(0x20, 20, 20 + jsonByteLength);
    bytes.set(encodedJson, 20);

    const binaryHeaderOffset = 20 + jsonByteLength;
    view.setUint32(binaryHeaderOffset, binary.byteLength, true);
    view.setUint32(binaryHeaderOffset + 4, 0x004e4942, true);
    bytes.set(binary, binaryHeaderOffset + 8);

    return glb;
}

function makeMockEngine() {
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => {
        const storage = new ArrayBuffer(Number(descriptor.size));
        return {
            destroy: vi.fn(),
            getMappedRange: vi.fn(() => storage),
            unmap: vi.fn(),
        } as unknown as GPUBuffer;
    });
    const createTexture = vi.fn(
        () =>
            ({
                createView: vi.fn(() => ({}) as GPUTextureView),
                destroy: vi.fn(),
            }) as unknown as GPUTexture
    );
    const device = {
        createBuffer,
        createSampler: vi.fn(() => ({}) as GPUSampler),
        createTexture,
        queue: {
            copyExternalImageToTexture: vi.fn(),
            writeTexture: vi.fn(),
        },
    } as unknown as GPUDevice;

    return {
        createBuffer,
        engine: { _device: device } as unknown as EngineContext,
    };
}

describe("loadGltf geometry sharing", () => {
    it("shares immutable primitive geometry between nodes that reference the same glTF mesh", async () => {
        const { createBuffer, engine } = makeMockEngine();
        const container = await loadGltf(engine, makeSharedMeshGlb());
        const root = container.entities[0] as TransformNode;
        const first = root.children[0]!.children[0] as Mesh;
        const second = root.children[1]!.children[0] as Mesh;

        expect(first).not.toBe(second);
        expect(second.boundMin).not.toEqual(first.boundMin);

        expect(second._gpu).toBe(first._gpu);
        expect(second._cpuPositions).toBe(first._cpuPositions);
        expect(second._cpuNormals).toBe(first._cpuNormals);
        expect(second._cpuUvs).toBe(first._cpuUvs);
        expect(second._cpuIndices).toBe(first._cpuIndices);
        expect(first._gpu._refCount).toBe(2);
        expect(createBuffer).toHaveBeenCalledTimes(4);

        const buffers = [first._gpu.positionBuffer, first._gpu.normalBuffer, first._gpu.uvBuffer, first._gpu.indexBuffer];
        disposeMeshGpu(first);
        for (const buffer of buffers) {
            expect(buffer.destroy).not.toHaveBeenCalled();
        }

        disposeMeshGpu(second);
        for (const buffer of buffers) {
            expect(buffer.destroy).toHaveBeenCalledTimes(1);
        }
    });
});
