import { describe, expect, it, vi } from "vitest";

import { _rebuildMeshes } from "../../../packages/babylon-lite/src/engine/device-lost-recovery.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { _installSharedRecovery } from "../../../packages/babylon-lite/src/loader-gltf/gltf-share.js";
import { disposeMeshGpu } from "../../../packages/babylon-lite/src/mesh/mesh-dispose.js";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { retain } from "../../../packages/babylon-lite/src/resource/ref-count.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";

function fakeBuffer(): GPUBuffer {
    return { destroy: vi.fn() } as unknown as GPUBuffer;
}

function makeGpu(): MeshGPU {
    return {
        positionBuffer: fakeBuffer(),
        normalBuffer: fakeBuffer(),
        uvBuffer: fakeBuffer(),
        indexBuffer: fakeBuffer(),
        indexCount: 3,
        indexFormat: "uint16",
    };
}

function makeMesh(gpu: MeshGPU): Mesh {
    return {
        _gpu: gpu,
        _cpuPositions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        _cpuNormals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        _cpuUvs: new Float32Array([0, 0, 1, 0, 0, 1]),
        _cpuIndices: new Uint32Array([0, 1, 2]),
        _cpuGpuIndices: new Uint16Array([0, 1, 2]),
        _cpuIndexFormat: "uint16",
    } as unknown as Mesh;
}

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

describe("device-lost shared geometry recovery", () => {
    it("rebuilds one MeshGPU and retains it for every existing owner", async () => {
        const oldGpu = makeGpu();
        _installSharedRecovery(oldGpu);
        retain(oldGpu);
        const first = makeMesh(oldGpu);
        const second = makeMesh(oldGpu);
        const { createBuffer, engine } = makeEngine();
        const scene = { meshes: [first, second] } as unknown as SceneContext;

        await _rebuildMeshes(engine, scene);

        expect(first._gpu).not.toBe(oldGpu);
        expect(second._gpu).toBe(first._gpu);
        expect(first._gpu._refCount).toBe(2);
        expect(createBuffer).toHaveBeenCalledTimes(4);

        const firstRecovery = first._gpu;
        await _rebuildMeshes(engine, scene);
        expect(first._gpu).toBe(firstRecovery);
        expect(second._gpu).toBe(firstRecovery);
        expect(first._gpu._refCount).toBe(2);
        expect(createBuffer).toHaveBeenCalledTimes(4);

        const replacement = makeEngine();
        await _rebuildMeshes(replacement.engine, scene);
        expect(first._gpu).not.toBe(firstRecovery);
        expect(second._gpu).toBe(first._gpu);
        expect(first._gpu._refCount).toBe(2);
        expect(replacement.createBuffer).toHaveBeenCalledTimes(4);

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
