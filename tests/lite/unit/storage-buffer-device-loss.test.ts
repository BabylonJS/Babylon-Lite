import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createMeshFromStorageBuffer } from "../../../packages/babylon-lite/src/mesh/mesh-from-storage";
import { disposeMeshGpu } from "../../../packages/babylon-lite/src/mesh/mesh-dispose";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh";
import { createStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";
import { _rebuildStorageBuffers } from "../../../packages/babylon-lite/src/resource/storage-buffer-recovery";
import { cloneTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";

const BU = globalThis.GPUBufferUsage;

function makeDevice() {
    const make = (d: GPUBufferDescriptor) => {
        const backing = new ArrayBuffer(Number(d.size));
        return {
            label: d.label,
            usage: Number(d.usage),
            size: Number(d.size),
            getMappedRange: () => backing,
            unmap: vi.fn(),
            destroy: vi.fn(),
        } as unknown as GPUBuffer;
    };
    return { createBuffer: vi.fn(make), queue: { writeBuffer: vi.fn() }, limits: { maxBufferSize: 256 * 1024 * 1024 } } as unknown as GPUDevice;
}

function makeEngine() {
    return { _device: makeDevice() } as unknown as EngineContext;
}

/** Swap in a replacement device, as device-lost recovery does, and rebuild. */
function loseDevice(engine: EngineContext): void {
    (engine as { _device: GPUDevice })._device = makeDevice();
    _rebuildStorageBuffers(engine);
}

describe("storage buffers survive a device loss", () => {
    it("keeps every usage flag the allocation was created with", () => {
        const engine = makeEngine();
        const slab = createStorageBuffer(engine, 256, { writable: true, vertex: true, index: true, label: "slab" });
        const before = (slab._buffer as unknown as { usage: number }).usage;

        loseDevice(engine);
        const after = (slab._buffer as unknown as { usage: number }).usage;

        // The regression: the rebuild recomputed usage as STORAGE|VERTEX only, so an
        // allocation shared as a topology could no longer bind as an index buffer, and a
        // compute target could no longer be copied out of — but only after a device loss,
        // which is exactly when nobody is looking.
        for (const [name, flag] of [
            ["STORAGE", BU.STORAGE],
            ["VERTEX", BU.VERTEX],
            ["INDEX", BU.INDEX],
            ["COPY_SRC", BU.COPY_SRC],
        ] as const) {
            expect(before & flag, `${name} at creation`).toBe(flag);
            expect(after & flag, `${name} after rebuild`).toBe(flag);
        }
    });

    it("does not add usages an allocation never asked for", () => {
        const engine = makeEngine();
        const plain = createStorageBuffer(engine, 64);
        loseDevice(engine);
        const after = (plain._buffer as unknown as { usage: number }).usage;
        expect(after & BU.VERTEX).toBe(0);
        expect(after & BU.INDEX).toBe(0);
        expect(after & BU.COPY_SRC).toBe(0);
    });

    it("re-points a slab-backed mesh at the rebuilt allocation", () => {
        const engine = makeEngine();
        const slab = createStorageBuffer(engine, 8 * 16 * 4, { writable: true, vertex: true });
        const topology = createStorageBuffer(engine, 64, { index: true });
        const mesh = createMeshFromStorageBuffer(engine, "chunk", {
            storage: slab,
            indices: topology,
            indexCount: 6,
            indexFormat: "uint32",
            vertexCount: 8,
            arrayStride: 16,
        });

        const deadVertex = mesh._gpu.positionBuffer;
        const deadIndex = mesh._gpu.indexBuffer;
        loseDevice(engine);

        // Without this the mesh keeps drawing from buffers that died with the old device.
        expect(mesh._gpu.positionBuffer).not.toBe(deadVertex);
        expect(mesh._gpu.positionBuffer).toBe(slab._buffer);
        expect(mesh._gpu.normalBuffer).toBe(slab._buffer);
        expect(mesh._gpu.uvBuffer).toBe(slab._buffer);
        expect(mesh._gpu.indexBuffer).not.toBe(deadIndex);
        expect(mesh._gpu.indexBuffer).toBe(topology._buffer);
    });

    it("re-points every optional slab stream advertised by the mesh", () => {
        const engine = makeEngine();
        const slab = createStorageBuffer(engine, 8 * 64, { writable: true, vertex: true });
        const mesh = createMeshFromStorageBuffer(engine, "full-layout", {
            storage: slab,
            indices: new Uint32Array([0, 1, 2]),
            vertexCount: 8,
            arrayStride: 64,
            attributeOffsets: { tangent: 24, uv2: 40, color: 48 },
        });
        const deadVertex = mesh._gpu.positionBuffer;

        loseDevice(engine);

        expect(mesh._gpu.positionBuffer).not.toBe(deadVertex);
        expect(mesh._gpu.tangentBuffer).toBe(slab._buffer);
        expect(mesh._gpu.uv2Buffer).toBe(slab._buffer);
        expect(mesh._gpu.colorBuffer).toBe(slab._buffer);
    });

    it.each([Uint16Array, Uint32Array])("recovers a private %s index snapshot once per device and shared geometry", (IndexArray) => {
        const engine = makeEngine();
        const slab = createStorageBuffer(engine, 8 * 16 * 4, { writable: true, vertex: true });
        const callerData = new IndexArray([99, 0, 1, 2, 7]);
        const mesh = createMeshFromStorageBuffer(engine, "chunk", {
            storage: slab,
            indices: callerData.subarray(1),
            indexCount: 3,
            vertexCount: 8,
            arrayStride: 16,
            baseVertex: 8,
        });
        const clone = cloneTransformNode(mesh) as Mesh;
        const ownedIndex = mesh._gpu.indexBuffer;
        const layout = mesh._gpu._vbLayout;
        callerData.fill(99);

        loseDevice(engine);

        expect(mesh._gpu.positionBuffer).toBe(slab._buffer);
        expect(mesh._gpu.indexBuffer).not.toBe(ownedIndex);
        expect(ownedIndex.destroy).toHaveBeenCalledOnce();
        expect(Array.from(new IndexArray(mesh._gpu.indexBuffer.getMappedRange(), 0, 3))).toEqual([0, 1, 2]);
        expect(mesh._gpu.indexCount).toBe(3);
        expect(mesh._gpu.indexFormat).toBe(IndexArray === Uint16Array ? "uint16" : "uint32");
        expect(mesh._gpu._vbLayout).toBe(layout);
        expect(mesh._gpu._baseVertex).toBe(8);
        expect(mesh._gpu.hasUv).toBe(true);
        expect(clone._gpu).toBe(mesh._gpu);
        expect(vi.mocked(engine._device.createBuffer).mock.calls.filter(([descriptor]) => descriptor.label === "chunk-indices")).toHaveLength(1);

        const recoveredIndex = mesh._gpu.indexBuffer;
        _rebuildStorageBuffers(engine);
        expect(mesh._gpu.indexBuffer).toBe(recoveredIndex);
        loseDevice(engine);
        expect(mesh._gpu.indexBuffer).not.toBe(recoveredIndex);
        expect(Array.from(new IndexArray(mesh._gpu.indexBuffer.getMappedRange(), 0, 3))).toEqual([0, 1, 2]);

        disposeMeshGpu(mesh);
        const liveIndex = clone._gpu.indexBuffer;
        expect(liveIndex.destroy).not.toHaveBeenCalled();
        loseDevice(engine);
        expect(clone._gpu.indexBuffer).not.toBe(liveIndex);
        const finalIndex = clone._gpu.indexBuffer;
        disposeMeshGpu(clone);
        expect(finalIndex.destroy).toHaveBeenCalledOnce();
        loseDevice(engine);
        expect(clone._gpu.indexBuffer).toBe(finalIndex);
        expect(vi.mocked(engine._device.createBuffer).mock.calls.filter(([descriptor]) => descriptor.label === "chunk-indices")).toHaveLength(0);
        expect(slab._destroyed).toBe(false);
    });

    it("does not destroy borrowed index allocations when their mesh is disposed", () => {
        const engine = makeEngine();
        const slab = createStorageBuffer(engine, 128, { writable: true, vertex: true });
        const indices = createStorageBuffer(engine, new Uint16Array([0, 1, 2]), { index: true });
        const mesh = createMeshFromStorageBuffer(engine, "shared", { storage: slab, indices, indexCount: 3, indexFormat: "uint16", vertexCount: 8, arrayStride: 16 });
        disposeMeshGpu(mesh);
        expect(indices._buffer!.destroy).not.toHaveBeenCalled();
        expect(slab._buffer!.destroy).not.toHaveBeenCalled();
    });

    it("removes the exact registry token on final disposal without waiting for recovery", () => {
        const engine = makeEngine();
        const slab = createStorageBuffer(engine, 128, { writable: true, vertex: true });
        const options = { storage: slab, indices: new Uint16Array([0, 1, 2]), vertexCount: 8, arrayStride: 16 };
        const add = vi.spyOn(Set.prototype, "add");
        const mesh = createMeshFromStorageBuffer(engine, "registry", options);
        const call = add.mock.calls.findIndex(([value]) => value instanceof WeakRef && value.deref() === mesh._gpu);
        expect(call).toBeGreaterThanOrEqual(0);
        const registry = add.mock.contexts[call] as Set<WeakRef<MeshGPU>>;
        const token = add.mock.calls[call]![0] as WeakRef<MeshGPU>;
        add.mockRestore();
        const withMesh = registry.size;
        const clone = cloneTransformNode(mesh) as Mesh;
        expect(registry.size).toBe(withMesh);
        disposeMeshGpu(mesh);
        expect(registry.has(token)).toBe(true);
        disposeMeshGpu(clone);
        expect(registry.has(token)).toBe(false);
        expect(registry.size).toBe(withMesh - 1);
        for (let index = 0; index < 128; index++) {
            const chunk = createMeshFromStorageBuffer(engine, "streamed", options);
            disposeMeshGpu(chunk);
        }
        expect(registry.size).toBe(withMesh - 1);
    });
});
