import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "babylon-lite";

import { LoadAssetContainerAsync } from "../src/loading/scene-loader";
import type { Scene } from "../src/scene/scene";

function makeEngine(): EngineContext {
    const device = {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const storage = new ArrayBuffer(Number(descriptor.size));
            return {
                destroy: vi.fn(),
                getMappedRange: vi.fn(() => storage),
                unmap: vi.fn(),
            } as unknown as GPUBuffer;
        }),
        createSampler: vi.fn(() => ({}) as GPUSampler),
        createTexture: vi.fn(
            () =>
                ({
                    createView: vi.fn(() => ({}) as GPUTextureView),
                    destroy: vi.fn(),
                }) as unknown as GPUTexture
        ),
        queue: {
            copyExternalImageToTexture: vi.fn(),
            writeBuffer: vi.fn(),
            writeTexture: vi.fn(),
        },
    } as unknown as GPUDevice;
    return { _device: device } as EngineContext;
}

function makeGltfSource(scatter: boolean): string {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
    const indices = new Uint16Array([0, 1, 2]);
    const bytes = new Uint8Array(positions.byteLength + normals.byteLength + uvs.byteLength + indices.byteLength);
    let offset = 0;
    for (const data of [positions, normals, uvs, indices]) {
        bytes.set(new Uint8Array(data.buffer), offset);
        offset += data.byteLength;
    }
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    const material = scatter ? { extensions: { KHR_materials_scatter: {} } } : {};
    const json = {
        asset: { version: "2.0" },
        ...(scatter ? { extensionsUsed: ["KHR_materials_scatter"] } : {}),
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
        materials: [material],
        buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${btoa(binary)}` }],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
            { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength },
            { buffer: 0, byteOffset: positions.byteLength + normals.byteLength, byteLength: uvs.byteLength },
            { buffer: 0, byteOffset: positions.byteLength + normals.byteLength + uvs.byteLength, byteLength: indices.byteLength },
        ],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
            { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
            { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" },
            { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" },
        ],
    };
    return `data:model/gltf+json,${encodeURIComponent(JSON.stringify(json))}`;
}

describe("KHR_materials_scatter loader guard", () => {
    it("loads ordinary glTF assets and rejects scatter through the native material pipeline", async () => {
        const engine = makeEngine();
        const scene = { getEngine: () => ({ _lite: engine }) } as Scene;

        await expect(LoadAssetContainerAsync(makeGltfSource(false), scene)).resolves.toBeDefined();
        await expect(LoadAssetContainerAsync(makeGltfSource(true), scene)).rejects.toThrow(/screen-space subsurface-scattering prepass/);
    });
});
