import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createMeshFromStorageBuffer, type MeshFromStorageOptions } from "../../../packages/babylon-lite/src/mesh/mesh-from-storage";
import { resizeMeshGeometry, updateMeshColors, updateMeshPositions } from "../../../packages/babylon-lite/src/mesh/mesh-factories";
import { createMeshVertexLayout } from "../../../packages/babylon-lite/src/mesh/mesh-vertex-layout";
import { applyMeshVertexBufferLayout } from "../../../packages/babylon-lite/src/mesh/mesh-vertex-buffer-layout";
import { composeShader } from "../../../packages/babylon-lite/src/shader/shader-composer";
import { createStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";
import type { VertexAttribute } from "../../../packages/babylon-lite/src/shader/fragment-types";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";

function makeEngine() {
    const device = {
        createBuffer: vi.fn((d: GPUBufferDescriptor) => {
            const backing = new ArrayBuffer(Number(d.size));
            return { label: d.label, size: Number(d.size), usage: Number(d.usage), getMappedRange: () => backing, unmap: vi.fn(), destroy: vi.fn() } as unknown as GPUBuffer;
        }),
        queue: { writeBuffer: vi.fn() },
        limits: { maxBufferSize: 256 * 1024 * 1024, maxVertexBufferArrayStride: 2048 },
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
    it.each(["joints", "weights", "joints1", "weights1", "typo"])("rejects unsupported %s offsets before allocating index data", (name) => {
        const engine = makeEngine();
        const storage = createStorageBuffer(engine, VERTS * STRIDE, { vertex: true });
        vi.mocked(engine._device.createBuffer).mockClear();
        expect(() =>
            createMeshFromStorageBuffer(engine, "invalid-offset", { storage, indices: INDICES, vertexCount: VERTS, arrayStride: STRIDE, attributeOffsets: { [name]: 0 } })
        ).toThrow(/unsupported attribute offset/);
        expect(engine._device.createBuffer).not.toHaveBeenCalled();
    });

    it.each([-1, 0.5, NaN, Infinity, STRIDE, STRIDE + 4])("rejects invalid offset %s before allocating index data", (offset) => {
        const engine = makeEngine();
        const storage = createStorageBuffer(engine, VERTS * STRIDE, { vertex: true });
        vi.mocked(engine._device.createBuffer).mockClear();
        expect(() =>
            createMeshFromStorageBuffer(engine, "invalid-offset", {
                storage,
                indices: INDICES,
                vertexCount: VERTS,
                arrayStride: STRIDE,
                attributeOffsets: { position: offset },
            })
        ).toThrow(/offset.*position/);
        expect(engine._device.createBuffer).not.toHaveBeenCalled();
    });

    it("ignores inherited offsets while retaining explicitly authored zero offsets", () => {
        const engine = makeEngine();
        const offsets = Object.create({ color: 12, joints: 32 }) as NonNullable<MeshFromStorageOptions["attributeOffsets"]>;
        offsets.tangent = 0;
        const { mesh } = slabMesh(engine, offsets);
        expect(mesh._gpu.hasColor).toBe(false);
        expect(mesh._gpu.colorBuffer).toBeNull();
        expect(mesh._gpu.hasTangent).toBe(true);
        expect(mesh._gpu._vbLayout!.tangent).toEqual({ _stride: STRIDE, _offset: 0 });
    });

    it("rejects a stride above the device limit before allocating an index buffer", () => {
        const engine = makeEngine();
        const storage = createStorageBuffer(engine, 4096 * VERTS, { vertex: true });
        vi.mocked(engine._device.createBuffer).mockClear();
        expect(() => createMeshFromStorageBuffer(engine, "stride", { storage, indices: INDICES, vertexCount: VERTS, arrayStride: 4096 })).toThrow(/maxVertexBufferArrayStride/);
        expect(engine._device.createBuffer).not.toHaveBeenCalled();
    });

    it("points tangent, uv2 and color at the slab when offsets are given for them", () => {
        const engine = makeEngine();
        const { slab, mesh } = slabMesh(engine, { position: 0, normal: 12, tangent: 24, uv2: 36, color: 40 });

        expect(mesh._gpu.tangentBuffer).toBe(slab._buffer);
        expect(mesh._gpu.uv2Buffer).toBe(slab._buffer);
        expect(mesh._gpu.colorBuffer).toBe(slab._buffer);
        expect(Object.getPrototypeOf(mesh._gpu._vbLayout)).toBeNull();
        expect(mesh._gpu._vbLayout!.tangent).toEqual({ _stride: STRIDE, _offset: 24 });
        expect(mesh._gpu._vbLayout!.uv2).toEqual({ _stride: STRIDE, _offset: 36 });
        expect(mesh._gpu._vbLayout!.color).toEqual({ _stride: STRIDE, _offset: 40 });
        expect(mesh._gpu.hasUv).toBe(true);
        expect(mesh._gpu._vertexCount).toBe(VERTS);
        expect(mesh._gpu.hasTangent).toBe(true);
        expect(mesh._gpu.hasUv2).toBe(true);
        expect(mesh._gpu.hasColor).toBe(true);
    });

    it("describes constant zero-stride packing for an absent optional stream", () => {
        const engine = makeEngine();
        const { mesh } = slabMesh(engine);

        // The regression: `_vbLayout` recorded all six at the slab's stride while only
        // three buffers pointed at the slab, so tangent/uv2/color were read at stride 48
        // out of a buffer that never held them.
        expect(mesh._gpu.tangentBuffer).toBeNull();
        expect(mesh._gpu.uv2Buffer).toBeNull();
        expect(mesh._gpu.colorBuffer).toBeNull();
        expect(mesh._gpu._vbLayout!.tangent).toEqual({ _stride: 0, _offset: 0 });
        expect(mesh._gpu._vbLayout!.uv2).toEqual({ _stride: 0, _offset: 0 });
        expect(mesh._gpu._vbLayout!.color).toEqual({ _stride: 0, _offset: 0 });
        expect(mesh._gpu.hasTangent).toBe(false);
        expect(mesh._gpu.hasUv2).toBe(false);
        expect(mesh._gpu.hasColor).toBe(false);
    });

    it("still binds position, normal and uv, which always come from the slab", () => {
        const engine = makeEngine();
        const { slab, mesh } = slabMesh(engine);
        expect(mesh._gpu.positionBuffer).toBe(slab._buffer);
        expect(mesh._gpu.normalBuffer).toBe(slab._buffer);
        expect(mesh._gpu.uvBuffer).toBe(slab._buffer);
        expect(mesh._gpu.hasUv).toBe(true);
    });

    it.each(["tangent", "uv2", "color"])("distinguishes a missing %s stream from an authored stream at offset zero", (name) => {
        const engine = makeEngine();
        const bare = slabMesh(engine).mesh;
        const authored = slabMesh(engine, { [name]: 0 }).mesh;
        expect(bare._gpu._vbKey).not.toBe(authored._gpu._vbKey);
    });

    it("rejects tightly-packed mutation APIs and directs callers to the source storage buffer", () => {
        const engine = makeEngine();
        const { mesh } = slabMesh(engine, { color: 40 });

        expect(() => updateMeshPositions(engine, mesh, new Float32Array(3))).toThrow(/update the source StorageBuffer/);
        expect(() => updateMeshColors(engine, mesh, new Float32Array(4))).toThrow(/update the source StorageBuffer/);
        expect(() => resizeMeshGeometry(engine, mesh, new Float32Array(3), new Float32Array(3), new Uint32Array([0, 0, 0]))).toThrow(/update the source StorageBuffer/);
    });

    it("rejects negative, fractional, and out-of-range base vertices", () => {
        const engine = makeEngine();
        const slab = createStorageBuffer(engine, VERTS * STRIDE, { writable: true, vertex: true });
        for (const baseVertex of [-1, 0.5, 0x80000000]) {
            expect(() =>
                createMeshFromStorageBuffer(engine, "invalid", {
                    storage: slab,
                    indices: INDICES,
                    vertexCount: VERTS,
                    arrayStride: STRIDE,
                    baseVertex,
                })
            ).toThrow(/baseVertex/);
        }
        expect(() =>
            createMeshFromStorageBuffer(engine, "overflow", {
                storage: slab,
                indices: INDICES,
                vertexCount: VERTS,
                arrayStride: STRIDE,
                baseVertex: 1,
            })
        ).toThrow(/allocation/);
    });
});

describe("storage mesh index validation", () => {
    function setup(overrides: Partial<MeshFromStorageOptions> = {}) {
        const engine = makeEngine();
        const options: MeshFromStorageOptions = {
            storage: createStorageBuffer(engine, VERTS * STRIDE, { writable: true, vertex: true }),
            indices: INDICES,
            vertexCount: VERTS,
            arrayStride: STRIDE,
            ...overrides,
        };
        vi.mocked(engine._device.createBuffer).mockClear();
        return { engine, options, create: () => createMeshFromStorageBuffer(engine, "indices", options) };
    }

    it.each([0, -1, 1.5, NaN, Infinity, -Infinity, 0x100000000])("rejects invalid count %s before allocating", (indexCount) => {
        const { engine, create } = setup({ indexCount });
        expect(create).toThrow(/indexCount/);
        expect(engine._device.createBuffer).not.toHaveBeenCalled();
    });

    it.each([Uint16Array, Uint32Array])("derives the %s format and validates only the used prefix", (IndexArray) => {
        const format = IndexArray === Uint16Array ? "uint16" : "uint32";
        const { create } = setup({ indices: new IndexArray([0, 1, VERTS - 1, VERTS]), indexCount: 3, indexFormat: format });
        const mesh = create();
        expect(mesh._gpu.indexCount).toBe(3);
        expect(mesh._gpu.indexFormat).toBe(format);
        expect(Array.from(new IndexArray(mesh._gpu.indexBuffer.getMappedRange(), 0, 3))).toEqual([0, 1, VERTS - 1]);
        expect(setup({ indices: new IndexArray([0, 1, 2]) }).create()._gpu.indexFormat).toBe(format);
    });

    it.each([Uint16Array, Uint32Array])("rejects %s indices outside the local vertex range", (IndexArray) => {
        const { engine, create } = setup({ indices: new IndexArray([0, 1, VERTS]) });
        expect(create).toThrow(/indices\[2\].*vertexCount/);
        expect(engine._device.createBuffer).not.toHaveBeenCalled();
    });

    it.each([Uint16Array, Uint32Array])("rejects a mismatched %s format", (IndexArray) => {
        const { engine, create } = setup({ indices: new IndexArray([0, 1, 2]), indexFormat: IndexArray === Uint16Array ? "uint32" : "uint16" });
        expect(create).toThrow(/indexFormat.*match/);
        expect(engine._device.createBuffer).not.toHaveBeenCalled();
    });

    it("rejects counts beyond the typed view, regardless of backing storage or GPU padding", () => {
        const { engine, create } = setup({ indices: new Uint16Array(12).subarray(3, 6), indexCount: 4 });
        expect(create).toThrow(/capacity of 3/);
        expect(engine._device.createBuffer).not.toHaveBeenCalled();
        expect(setup({ indices: new Uint32Array(0) }).create).toThrow(/indexCount/);
    });

    it.each(["uint16", "uint32"] as const)("validates shared %s capacity and requires an explicit count", (indexFormat) => {
        const { engine, options } = setup();
        const indices = createStorageBuffer(engine, 16, { index: true });
        const capacity = indexFormat === "uint16" ? 8 : 4;
        const create = (indexCount?: number) => createMeshFromStorageBuffer(engine, "shared", { ...options, indices, indexFormat, indexCount });
        vi.mocked(engine._device.createBuffer).mockClear();
        expect(create(capacity)._gpu.indexBuffer).toBe(indices._buffer);
        for (const count of [undefined, 0, -1, 0.5, NaN, Infinity, 0x100000000, capacity + 1]) {
            expect(() => create(count)).toThrow(/indexCount/);
        }
        expect(engine._device.createBuffer).not.toHaveBeenCalled();
    });

    it("rejects missing or unsupported shared formats and missing INDEX usage", () => {
        const { engine, options } = setup();
        const indices = createStorageBuffer(engine, 16, { index: true });
        for (const indexFormat of [undefined, "uint8" as GPUIndexFormat]) {
            expect(() => createMeshFromStorageBuffer(engine, "shared", { ...options, indices, indexCount: 3, indexFormat })).toThrow(/indexFormat/);
        }
        expect(() => createMeshFromStorageBuffer(engine, "shared", { ...options, indices: options.storage, indexCount: 3, indexFormat: "uint32" })).toThrow(/index: true/);
    });
});

describe("central mesh vertex layout", () => {
    const names = ["position", "normal", "tangent", "uv", "uv2", "color"] as const;
    const formats = ["float32x3", "float32x3", "float32x4", "float32x2", "float32x2", "float32x4"] as const;
    const offsets = [0, 12, 24, 40, 48, 56] as const;
    const layout = createMeshVertexLayout({
        position: { _stride: 72, _offset: offsets[0] },
        normal: { _stride: 72, _offset: offsets[1] },
        tangent: { _stride: 72, _offset: offsets[2] },
        uv: { _stride: 72, _offset: offsets[3] },
        uv2: { _stride: 72, _offset: offsets[4] },
        color: { _stride: 72, _offset: offsets[5] },
    });

    it("keeps unknown attribute names on canonical layouts instead of reading object prototypes", () => {
        const canonical: GPUVertexBufferLayout = { arrayStride: 4, attributes: [{ shaderLocation: 0, offset: 0, format: "float32" }] };
        expect(Object.getPrototypeOf(layout)).toBeNull();
        expect(layout.toString).toBeUndefined();
        expect(applyMeshVertexBufferLayout([canonical], ["toString"], layout)[0]).toBe(canonical);
        const composed = composeShader(
            {
                _vertexTemplate: wgsl``,
                _fragmentTemplate: wgsl``,
                _baseMeshUboFields: [],
                _baseVertexAttributes: [{ _name: "toString", _type: "f32", _gpuFormat: "float32", _arrayStride: 4 }],
                _baseVaryings: [],
            },
            [],
            layout
        );
        expect(composed._vertexBufferLayouts[0]!.arrayStride).toBe(4);
    });

    it("rewrites every advertised composer stream", () => {
        const attributes: VertexAttribute[] = names.map((name, i) => ({
            _name: name,
            _type: "vec4<f32>",
            _gpuFormat: formats[i]!,
            _arrayStride: 16,
        }));
        const resolved = composeShader(
            { _vertexTemplate: wgsl``, _fragmentTemplate: wgsl``, _baseMeshUboFields: [], _baseVertexAttributes: attributes, _baseVaryings: [] },
            [],
            layout
        )._vertexBufferLayouts;
        for (let i = 0; i < names.length; i++) {
            expect(resolved[i]!.arrayStride).toBe(72);
            expect(resolved[i]!.attributes[0]!.offset).toBe(offsets[i]);
            expect(attributes[i]!._arrayStride).toBe(16);
            expect(attributes[i]!._offset).toBeUndefined();
        }
    });

    it("rewrites every advertised Shader/Node pipeline stream", () => {
        const layouts: GPUVertexBufferLayout[] = names.map((_, i) => ({
            arrayStride: 16,
            attributes: [{ shaderLocation: i, offset: 0, format: formats[i]! }],
        }));
        const resolved = applyMeshVertexBufferLayout(layouts, names, layout);
        for (let i = 0; i < names.length; i++) {
            expect(resolved[i]!.arrayStride).toBe(72);
            expect(resolved[i]!.attributes[0]!.offset).toBe(offsets[i]);
        }
    });

    it("routes every material and geometry family through the mesh-owned layout contract", async () => {
        const { readFileSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const expected = new Map([
            ["packages/babylon-lite/src/material/standard/standard-pipeline.ts", "meshVertexLayout"],
            ["packages/babylon-lite/src/material/standard/standard-geometry-renderable.ts", "mesh._gpu._vbLayout"],
            ["packages/babylon-lite/src/material/pbr/pbr-compose.ts", "composeShader(template, frags, vbStrides)"],
            ["packages/babylon-lite/src/material/pbr/pbr-geometry-renderable.ts", "mesh._gpu._vbLayout"],
            ["packages/babylon-lite/src/material/node/node-pipeline.ts", "meshVertexLayout?.[attribute._name]"],
            ["packages/babylon-lite/src/material/node/node-geometry-renderable.ts", "_pipelineForMesh(mesh._gpu)"],
            ["packages/babylon-lite/src/material/shader/shader-vb.ts", "bindings.vertexBuffers.map("],
            ["packages/babylon-lite/src/material/shader/shader-thin-instance.ts", "mesh._gpu._vbLayout[material.attributes[index]!]"],
        ]);
        for (const [file, token] of expected) {
            const source = readFileSync(resolve(process.cwd(), file), "utf8");
            expect(source, file).toContain(token);
            expect(source, `${file} must encode slab offsets in the pipeline, not the bind call`).not.toMatch(/setVertexBuffer\([^\n]*_offset/);
        }
    });
});
