import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createMeshFromStorageBuffer } from "../../../packages/babylon-lite/src/mesh/mesh-from-storage";
import { createStorageBuffer, _rebuildStorageBuffers } from "../../../packages/babylon-lite/src/resource/storage-buffer";

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
    return { createBuffer: vi.fn(make), queue: { writeBuffer: vi.fn() }, limits: {} } as unknown as GPUDevice;
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

    it("leaves an owned index buffer alone when only the vertex slab is borrowed", () => {
        const engine = makeEngine();
        const slab = createStorageBuffer(engine, 8 * 16 * 4, { writable: true, vertex: true });
        const mesh = createMeshFromStorageBuffer(engine, "chunk", {
            storage: slab,
            indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
            vertexCount: 8,
            arrayStride: 16,
        });
        const ownedIndex = mesh._gpu.indexBuffer;

        loseDevice(engine);

        expect(mesh._gpu.positionBuffer).toBe(slab._buffer);
        // Not sourced from a StorageBuffer, so it is not this observer's to re-point:
        // an owned index buffer is restored by the mesh's own recovery path.
        expect(mesh._gpu.indexBuffer).toBe(ownedIndex);
    });
});
