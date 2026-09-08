import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createMeshFromStorageBuffer } from "../../../packages/babylon-lite/src/mesh/mesh-from-storage";
import { createStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";

function makeEngine() {
    const device = {
        createBuffer: vi.fn((d: GPUBufferDescriptor) => {
            const backing = new ArrayBuffer(Number(d.size));
            return { label: d.label, size: Number(d.size), usage: Number(d.usage), getMappedRange: () => backing, unmap: vi.fn(), destroy: vi.fn() } as unknown as GPUBuffer;
        }),
        queue: { writeBuffer: vi.fn() },
        limits: {},
    } as unknown as GPUDevice;
    return { _device: device } as unknown as EngineContext;
}

const STRIDE = 48;
const VERTS = 8;
const INDICES = new Uint32Array([0, 1, 2, 2, 1, 3]);

function slabMesh(engine: EngineContext, attributeOffsets?: Record<string, number>) {
    const slab = createStorageBuffer(engine, VERTS * STRIDE, { writable: true, vertex: true });
    const mesh = createMeshFromStorageBuffer(engine, "chunk", {
        storage: slab,
        indices: INDICES,
        vertexCount: VERTS,
        arrayStride: STRIDE,
        ...(attributeOffsets ? { attributeOffsets } : {}),
    });
    return { slab, mesh };
}

/**
 * `attributeOffsets` accepts all six streams `MeshVbLayout` describes. Anything it
 * accepts has to actually read from the slab: describing an attribute at the slab's
 * stride while its buffer is a tiny zero fallback hands the pipeline a stride far
 * larger than the buffer backing it.
 */
describe("slab meshes bind every stream they advertise", () => {
    it("points tangent, uv2 and color at the slab when offsets are given for them", () => {
        const engine = makeEngine();
        const { slab, mesh } = slabMesh(engine, { position: 0, normal: 12, tangent: 24, uv2: 36, color: 40 });

        expect(mesh._gpu.tangentBuffer).toBe(slab._buffer);
        expect(mesh._gpu.uv2Buffer).toBe(slab._buffer);
        expect(mesh._gpu.colorBuffer).toBe(slab._buffer);
        expect(mesh._gpu._vbLayout!._t).toEqual({ _stride: STRIDE, _offset: 24 });
        expect(mesh._gpu._vbLayout!._u2).toEqual({ _stride: STRIDE, _offset: 36 });
        expect(mesh._gpu._vbLayout!._c).toEqual({ _stride: STRIDE, _offset: 40 });
    });

    it("describes no packing for a stream it does not bind", () => {
        const engine = makeEngine();
        const { mesh } = slabMesh(engine);

        // The regression: `_vbLayout` recorded all six at the slab's stride while only
        // three buffers pointed at the slab, so tangent/uv2/color were read at stride 48
        // out of a buffer that never held them.
        expect(mesh._gpu.tangentBuffer).toBeNull();
        expect(mesh._gpu.uv2Buffer).toBeNull();
        expect(mesh._gpu.colorBuffer).toBeNull();
        expect(mesh._gpu._vbLayout!._t).toBeUndefined();
        expect(mesh._gpu._vbLayout!._u2).toBeUndefined();
        expect(mesh._gpu._vbLayout!._c).toBeUndefined();
    });

    it("still binds position, normal and uv, which always come from the slab", () => {
        const engine = makeEngine();
        const { slab, mesh } = slabMesh(engine);
        expect(mesh._gpu.positionBuffer).toBe(slab._buffer);
        expect(mesh._gpu.normalBuffer).toBe(slab._buffer);
        expect(mesh._gpu.uvBuffer).toBe(slab._buffer);
    });

    it("gives meshes with different advertised streams different pipeline keys", () => {
        const engine = makeEngine();
        const bare = slabMesh(engine).mesh;
        const withColor = slabMesh(engine, { color: 40 }).mesh;
        expect(bare._gpu._vbKey).not.toBe(withColor._gpu._vbKey);
    });
});
