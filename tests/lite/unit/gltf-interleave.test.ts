import { describe, it, expect, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import {
    accessorIsStrided,
    buildInterleavedMesh,
    buildInterleavedPartial,
    installLazyCpu,
    computeAabbStrided,
} from "../../../packages/babylon-lite/src/loader-gltf/gltf-interleave.js";
import type { GltfMeshData } from "../../../packages/babylon-lite/src/loader-gltf/load-gltf.js";

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;

interface TestAccessor {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
}

/** Build a minimal glTF JSON + binary chunk with POSITION+NORMAL interleaved in
 *  one stride-24 bufferView (offset 0 and 12), plus a tight TEXCOORD_0 bufferView. */
function makeInterleavedAsset() {
    const verts = 2;
    // Interleaved: [px,py,pz, nx,ny,nz] * 2  (24 bytes/vertex)
    const interleaved = new Float32Array([1, 2, 3, 0, 0, 1, 4, 5, 6, 0, 1, 0]);
    // Tight UVs: [u,v] * 2
    const uvs = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const buf = new ArrayBuffer(interleaved.byteLength + uvs.byteLength);
    new Float32Array(buf, 0, interleaved.length).set(interleaved);
    new Float32Array(buf, interleaved.byteLength, uvs.length).set(uvs);
    const binChunk = new DataView(buf);

    const accessors: TestAccessor[] = [
        { bufferView: 0, byteOffset: 0, componentType: FLOAT, count: verts, type: "VEC3" }, // POSITION
        { bufferView: 0, byteOffset: 12, componentType: FLOAT, count: verts, type: "VEC3" }, // NORMAL
        { bufferView: 1, byteOffset: 0, componentType: FLOAT, count: verts, type: "VEC2" }, // TEXCOORD_0
    ];
    const json = {
        accessors,
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: interleaved.byteLength, byteStride: 24 },
            { buffer: 0, byteOffset: interleaved.byteLength, byteLength: uvs.byteLength }, // tight, no stride
        ],
    };
    const primitive = { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 } };
    return { json, binChunk, primitive };
}

describe("gltf-interleave", () => {
    it("accessorIsStrided detects interleaved vs tight bufferViews", () => {
        const { json } = makeInterleavedAsset();
        expect(accessorIsStrided(json, 0)).toBe(true); // POSITION (stride 24 ≠ 12)
        expect(accessorIsStrided(json, 1)).toBe(true); // NORMAL (stride 24 ≠ 12)
        expect(accessorIsStrided(json, 2)).toBe(false); // TEXCOORD_0 (no byteStride)
    });

    it("treats a zero-initialized accessor without a bufferView as tight", () => {
        expect(
            accessorIsStrided(
                {
                    accessors: [{ componentType: FLOAT, count: 2, type: "VEC3" }],
                    bufferViews: [],
                },
                0
            )
        ).toBe(false);
    });

    it("leaves strided POSITION/NORMAL CPU fields null (lazy) but records the GPU layout", async () => {
        const { json, binChunk, primitive } = makeInterleavedAsset();
        const m = (await buildInterleavedPartial(json, binChunk, primitive, new Float32Array(16) as never, 0))!;
        expect(m).toBeDefined();

        // Strided position/normal are NOT de-strided eagerly — the tight copy is
        // built only on demand, so the partial leaves these null.
        expect(m._positions).toBeNull();
        expect(m._normals).toBeNull();
        // Tight UVs resolved through the normal (non-strided) path are present.
        expect(Array.from(m._uvs!)).toEqual([0.1, 0.2, 0.3, 0.4].map((v) => Math.fround(v)));
        expect(m._vertexCount).toBe(2);

        // GPU interleave layout: shared stride 24, position at byte offset 0, normal at 12.
        // The byte offset is baked into the pipeline vertex layout (attributes[].offset);
        // the draw binds the shared buffer at offset 0 (matches Babylon.js WebGPU).
        expect(m._vb!._p).toMatchObject({ _stride: 24, _offset: 0, _bufferView: 0 });
        expect(m._vb!._n).toMatchObject({ _stride: 24, _offset: 12, _bufferView: 0 });
        // The tight UV attribute has no interleave entry.
        expect(m._vb!._u).toBeUndefined();
    });

    it("installLazyCpu de-strides position/normal only on first access", async () => {
        const { json, binChunk, primitive } = makeInterleavedAsset();
        const m = (await buildInterleavedPartial(json, binChunk, primitive, new Float32Array(16) as never, 0))!;
        const mesh: Record<string, unknown> = {};
        installLazyCpu(mesh, m as never);

        // Lazy getters reconstruct the tight CPU copy from the strided source.
        expect(Array.from(mesh._cpuPositions as Float32Array)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(Array.from(mesh._cpuNormals as Float32Array)).toEqual([0, 0, 1, 0, 1, 0]);
        // Tight UV is assigned directly (not via a getter).
        expect(Array.from(mesh._cpuUvs as Float32Array)).toEqual([0.1, 0.2, 0.3, 0.4].map((v) => Math.fround(v)));

        // Cached: repeated reads return the same array instance.
        expect(mesh._cpuPositions).toBe(mesh._cpuPositions);
    });

    it("shares lazy CPU copies across meshes created from one cached primitive", async () => {
        const { json, binChunk, primitive } = makeInterleavedAsset();
        const m = (await buildInterleavedPartial(json, binChunk, primitive, new Float32Array(16) as never, 0))!;
        const first: Record<string, unknown> = {};
        const second: Record<string, unknown> = {};

        expect(m._vb!._p!._cpu).toBeUndefined();
        expect(m._vb!._n!._cpu).toBeUndefined();
        installLazyCpu(first, m as never);
        installLazyCpu(second, m as never);

        expect(m._vb!._p!._cpu).toBeUndefined();
        expect(m._vb!._n!._cpu).toBeUndefined();
        const positions = first._cpuPositions;
        const normals = first._cpuNormals;
        expect(m._vb!._p!._cpu).toBe(positions);
        expect(m._vb!._n!._cpu).toBe(normals);
        expect(second._cpuPositions).toBe(positions);
        expect(second._cpuNormals).toBe(normals);

        const replacement = new Float32Array([7, 8, 9]);
        second._cpuPositions = replacement;
        expect(second._cpuPositions).toBe(replacement);
        expect(first._cpuPositions).toBe(positions);
    });

    it("computeAabbStrided folds the AABB directly from the strided slice", async () => {
        const { json, binChunk, primitive } = makeInterleavedAsset();
        const m = (await buildInterleavedPartial(json, binChunk, primitive, new Float32Array(16) as never, 0))!;
        const [min, max] = computeAabbStrided(m._vb!._p!);
        expect(min).toEqual([1, 2, 3]);
        expect(max).toEqual([4, 5, 6]);
    });

    it("returns undefined for a fully-tight primitive (caller uses the tight path)", async () => {
        const { json, binChunk } = makeInterleavedAsset();
        const tightOnly = { attributes: { TEXCOORD_0: 2 } };
        expect(await buildInterleavedPartial(json, binChunk, tightOnly, new Float32Array(16) as never, 0)).toBeUndefined();
    });

    it("includes TEXCOORD_1 packing in the pipeline key", () => {
        const device = {
            createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
                const mapped = new ArrayBuffer(Number(descriptor.size));
                return { getMappedRange: () => mapped, unmap: vi.fn(), destroy: vi.fn() } as unknown as GPUBuffer;
            }),
            queue: { writeBuffer: vi.fn() },
        } as unknown as GPUDevice;
        const engine = { _device: device } as unknown as EngineContext;
        const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const meshData = (stride: number, offset: number): GltfMeshData => ({
            _positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            _normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
            _tangents: null,
            _uvs: new Float32Array(6),
            _uv2s: new Float32Array(6),
            _colors: null,
            _indices: new Uint16Array([0, 1, 2]),
            _vertexCount: 3,
            _indexCount: 3,
            _worldMatrix: matrix as never,
            _material: {} as never,
            _nodeIndex: 0,
            _primitive: {},
            _vb: {
                _u2: {
                    _bufferView: 0,
                    _stride: stride,
                    _offset: offset,
                    _componentType: FLOAT,
                    _componentCount: 2,
                    _count: 3,
                    _slice: new Uint8Array(stride * 3),
                },
            },
        });

        const first = buildInterleavedMesh(engine, meshData(40, 24), 0, {} as never);
        const second = buildInterleavedMesh(engine, meshData(48, 28), 1, {} as never);

        expect(first._gpu._vbKey).not.toBe(second._gpu._vbKey);
    });

    it("materializes zero-initialized colors when another attribute is interleaved", async () => {
        const { json, binChunk, primitive } = makeInterleavedAsset();
        const colorIndex = json.accessors.length;
        json.accessors.push({ componentType: FLOAT, count: 2, type: "VEC3" });
        (primitive.attributes as Record<string, number>).COLOR_0 = colorIndex;

        const partial = (await buildInterleavedPartial(json, binChunk, primitive, new Float32Array(16) as never, 0))!;

        expect(Array.from(partial._colors!)).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
    });

    it("materializes zero-initialized normalized UVs when another attribute is interleaved", async () => {
        const { json, binChunk, primitive } = makeInterleavedAsset();
        const uvIndex = json.accessors.length;
        json.accessors.push({ componentType: UNSIGNED_BYTE, count: 2, type: "VEC2", normalized: true });
        (primitive.attributes as Record<string, number>).TEXCOORD_0 = uvIndex;

        const partial = (await buildInterleavedPartial(json, binChunk, primitive, new Float32Array(16) as never, 0))!;

        expect(Array.from(partial._uvs!)).toEqual([0, 0, 0, 0]);
    });
});
