import { describe, it, expect } from "vitest";
import { accessorIsStrided, buildInterleavedPartial, installLazyCpu, computeAabbStrided } from "../../../packages/babylon-lite/src/loader-gltf/gltf-interleave.js";

const FLOAT = 5126;

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

    const json = {
        accessors: [
            { bufferView: 0, byteOffset: 0, componentType: FLOAT, count: verts, type: "VEC3" }, // POSITION
            { bufferView: 0, byteOffset: 12, componentType: FLOAT, count: verts, type: "VEC3" }, // NORMAL
            { bufferView: 1, byteOffset: 0, componentType: FLOAT, count: verts, type: "VEC2" }, // TEXCOORD_0
        ],
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

    it("leaves strided POSITION/NORMAL CPU fields null (lazy) but records the GPU layout", () => {
        const { json, binChunk, primitive } = makeInterleavedAsset();
        const m = buildInterleavedPartial(json, binChunk, primitive, new Float32Array(16) as never, 0)!;
        expect(m).toBeDefined();

        // Strided position/normal are NOT de-strided eagerly — the tight copy is
        // built only on demand, so the partial leaves these null.
        expect(m._positions).toBeNull();
        expect(m._normals).toBeNull();
        // Tight UVs resolved through the normal (non-strided) path are present.
        expect(Array.from(m._uvs!)).toEqual([0.1, 0.2, 0.3, 0.4].map((v) => Math.fround(v)));
        expect(m._vertexCount).toBe(2);

        // GPU interleave layout: shared stride 24, position at 0, normal at 12.
        expect(m._vb!._p).toMatchObject({ _stride: 24, _offset: 0, _bufferView: 0 });
        expect(m._vb!._n).toMatchObject({ _stride: 24, _offset: 12, _bufferView: 0 });
        // The tight UV attribute has no interleave entry.
        expect(m._vb!._u).toBeUndefined();
    });

    it("installLazyCpu de-strides position/normal only on first access", () => {
        const { json, binChunk, primitive } = makeInterleavedAsset();
        const m = buildInterleavedPartial(json, binChunk, primitive, new Float32Array(16) as never, 0)!;
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

    it("computeAabbStrided folds the AABB directly from the strided slice", () => {
        const { json, binChunk, primitive } = makeInterleavedAsset();
        const m = buildInterleavedPartial(json, binChunk, primitive, new Float32Array(16) as never, 0)!;
        const [min, max] = computeAabbStrided(m._vb!._p!);
        expect(min).toEqual([1, 2, 3]);
        expect(max).toEqual([4, 5, 6]);
    });

    it("returns undefined for a fully-tight primitive (caller uses the tight path)", () => {
        const { json, binChunk } = makeInterleavedAsset();
        const tightOnly = { attributes: { TEXCOORD_0: 2 } };
        expect(buildInterleavedPartial(json, binChunk, tightOnly, new Float32Array(16) as never, 0)).toBeUndefined();
    });
});
