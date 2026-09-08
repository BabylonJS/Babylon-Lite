import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createMeshFromStorageBuffer } from "../../../packages/babylon-lite/src/mesh/mesh-from-storage";
import { disposeMeshGpu } from "../../../packages/babylon-lite/src/mesh/mesh-dispose";
import { createStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";

const BU_INDEX = 0x10;

function makeEngine() {
    const created: { label?: string; usage: number; destroy: ReturnType<typeof vi.fn> }[] = [];
    const make = (d: GPUBufferDescriptor) => {
        const backing = new ArrayBuffer(Number(d.size));
        const buf = {
            label: d.label,
            usage: Number(d.usage),
            size: Number(d.size),
            getMappedRange: () => backing,
            unmap: vi.fn(),
            destroy: vi.fn(),
        };
        created.push(buf as unknown as (typeof created)[number]);
        return buf as unknown as GPUBuffer;
    };
    const device = {
        createBuffer: vi.fn(make),
        queue: { writeBuffer: vi.fn() },
        limits: {},
    } as unknown as GPUDevice;
    return { engine: { _device: device } as unknown as EngineContext, created };
}

const STRIDE = 16;
const VERTS = 8;
const INDICES = new Uint32Array([0, 1, 2, 2, 1, 3]);

describe("createMeshFromStorageBuffer resource ownership", () => {
    it("does not destroy the shared slab when one slot's mesh is disposed", () => {
        const { engine } = makeEngine();
        const slab = createStorageBuffer(engine, VERTS * STRIDE * 4, { writable: true, vertex: true });
        const slabHandle = slab._buffer as unknown as { destroy: ReturnType<typeof vi.fn> };
        const meshes = [0, 1, 2, 3].map((i) =>
            createMeshFromStorageBuffer(engine, `chunk${i}`, {
                storage: slab,
                indices: INDICES,
                vertexCount: VERTS,
                arrayStride: STRIDE,
                baseVertex: i * VERTS,
            })
        );

        // Retiring one slot is routine — an LOD merge does it constantly. Before
        // this, it destroyed the allocation the other three still draw from, and
        // the symptom appears on the NEXT frame, far from the cause.
        disposeMeshGpu(meshes[0]!);
        expect(slabHandle.destroy).not.toHaveBeenCalled();

        for (const mesh of meshes.slice(1)) disposeMeshGpu(mesh);
        expect(slabHandle.destroy).not.toHaveBeenCalled();
    });

    it("still destroys a per-mesh index buffer, which the mesh does own", () => {
        const { engine, created } = makeEngine();
        const slab = createStorageBuffer(engine, VERTS * STRIDE, { writable: true, vertex: true });
        const mesh = createMeshFromStorageBuffer(engine, "chunk", { storage: slab, indices: INDICES, vertexCount: VERTS, arrayStride: STRIDE });
        const indexBuffer = created.find((b) => b.label === "chunk-indices")!;
        disposeMeshGpu(mesh);
        expect(indexBuffer.destroy).toHaveBeenCalledTimes(1);
    });
});

describe("shared index topology", () => {
    it("uploads one index allocation for every slot instead of one per mesh", () => {
        const { engine, created } = makeEngine();
        const slab = createStorageBuffer(engine, 64 * VERTS * STRIDE, { writable: true, vertex: true });
        const topology = createStorageBuffer(engine, INDICES, { index: true, label: "shared-topology" });
        const before = created.length;
        const meshes = [];
        for (let i = 0; i < 64; i++) {
            meshes.push(
                createMeshFromStorageBuffer(engine, `chunk${i}`, {
                    storage: slab,
                    indices: topology,
                    indexCount: INDICES.length,
                    indexFormat: "uint32",
                    vertexCount: VERTS,
                    arrayStride: STRIDE,
                    baseVertex: i * VERTS,
                })
            );
        }
        // 64 meshes, zero new GPU buffers.
        expect(created.length).toBe(before);
        expect(meshes[0]!._gpu.indexCount).toBe(INDICES.length);
        expect(meshes[0]!._gpu.indexBuffer).toBe(meshes[63]!._gpu.indexBuffer);
    });

    it("does not destroy a shared topology with the mesh", () => {
        const { engine } = makeEngine();
        const slab = createStorageBuffer(engine, VERTS * STRIDE, { writable: true, vertex: true });
        const topology = createStorageBuffer(engine, INDICES, { index: true });
        const handle = topology._buffer as unknown as { destroy: ReturnType<typeof vi.fn> };
        const mesh = createMeshFromStorageBuffer(engine, "chunk", {
            storage: slab,
            indices: topology,
            indexCount: INDICES.length,
            indexFormat: "uint32",
            vertexCount: VERTS,
            arrayStride: STRIDE,
        });
        disposeMeshGpu(mesh);
        expect(handle.destroy).not.toHaveBeenCalled();
    });

    it("marks the allocation with INDEX usage", () => {
        const { engine } = makeEngine();
        const topology = createStorageBuffer(engine, INDICES, { index: true });
        expect((topology._buffer as unknown as { usage: number }).usage & BU_INDEX).toBe(BU_INDEX);
    });

    it("rejects an allocation that was not created for indices", () => {
        const { engine } = makeEngine();
        const slab = createStorageBuffer(engine, VERTS * STRIDE, { writable: true, vertex: true });
        const notIndices = createStorageBuffer(engine, INDICES);
        expect(() =>
            createMeshFromStorageBuffer(engine, "chunk", { storage: slab, indices: notIndices, indexCount: 6, indexFormat: "uint32", vertexCount: VERTS, arrayStride: STRIDE })
        ).toThrow(/index: true/);
    });

    it("requires an explicit indexCount for a shared allocation", () => {
        const { engine } = makeEngine();
        const slab = createStorageBuffer(engine, VERTS * STRIDE, { writable: true, vertex: true });
        const topology = createStorageBuffer(engine, INDICES, { index: true });
        // The allocation's byte length is padded, so it cannot stand in for the
        // draw count — guessing would silently draw the wrong number of indices.
        expect(() => createMeshFromStorageBuffer(engine, "chunk", { storage: slab, indices: topology, indexFormat: "uint32", vertexCount: VERTS, arrayStride: STRIDE })).toThrow(
            /indexCount/
        );
    });

    it("requires an explicit indexFormat for a shared allocation", () => {
        const { engine } = makeEngine();
        const slab = createStorageBuffer(engine, VERTS * STRIDE, { writable: true, vertex: true });
        const topology = createStorageBuffer(engine, INDICES, { index: true });
        // A 16-bit topology declared as 32-bit fails WebGPU validation with a
        // buffer-size complaint that points at the allocation, not the format.
        expect(() => createMeshFromStorageBuffer(engine, "chunk", { storage: slab, indices: topology, indexCount: 6, vertexCount: VERTS, arrayStride: STRIDE })).toThrow(
            /indexFormat/
        );
    });

    it("derives the format from a typed array's element size", () => {
        const { engine } = makeEngine();
        const slab = createStorageBuffer(engine, VERTS * STRIDE, { writable: true, vertex: true });
        const wide = createMeshFromStorageBuffer(engine, "wide", { storage: slab, indices: INDICES, vertexCount: VERTS, arrayStride: STRIDE });
        const narrow = createMeshFromStorageBuffer(engine, "narrow", { storage: slab, indices: new Uint16Array([0, 1, 2]), vertexCount: VERTS, arrayStride: STRIDE });
        expect(wide._gpu.indexFormat).toBe("uint32");
        expect(narrow._gpu.indexFormat).toBe("uint16");
    });
});
