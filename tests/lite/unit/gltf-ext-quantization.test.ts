import { describe, it, expect } from "vitest";
import quantizationFeature from "../../../packages/babylon-lite/src/loader-gltf/gltf-ext-quantization.js";

const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const FLOAT = 5126;

/** Read `count` floats starting at byte `offset` from a DataView (all-FLOAT bufferViews the
 *  feature appends are little-endian and tightly packed). */
function readFloats(view: DataView, offset: number, count: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
        out.push(view.getFloat32(offset + i * 4, true));
    }
    return out;
}

// Regression coverage for Scene 220 (Duck glTF-Quantized): KHR_mesh_quantization allows an
// UNNORMALIZED integer TEXCOORD_n/POSITION accessor whose raw value IS the literal data
// (rescaled back to real units by a node transform or KHR_texture_transform on the material).
// The core loader's tight/interleave UV and vertex paths always treat an unsigned-integer
// source as normalized ([0,1]/[0,255]/[0,65535]) — so the quantization feature's `preParse`
// hook must rewrite EVERY unnormalized unsigned-int VEC2/VEC3 accessor to FLOAT (preserving the
// raw value, not dividing it), regardless of whether it happens to be tightly packed or
// strided. Indices (SCALAR) and JOINTS_n (VEC4) must never be rewritten.
describe("gltf-ext-quantization preParse — unnormalized unsigned-int accessors", () => {
    it("rewrites a TIGHT unnormalized UNSIGNED_SHORT VEC2 TEXCOORD_0 to FLOAT, preserving raw values (Duck case)", async () => {
        // 2 vertices, VEC2 UNSIGNED_SHORT, byteStride 4 == tight size (this is exactly what let
        // Duck's TEXCOORD_0 escape the old stride-gated predicate).
        const buf = new ArrayBuffer(8);
        new Uint16Array(buf).set([0, 65535, 100, 200]);
        const binChunk = new DataView(buf);
        const json: any = {
            accessors: [{ bufferView: 0, componentType: UNSIGNED_SHORT, count: 2, type: "VEC2" }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8, byteStride: 4 }],
        };

        const outView = await quantizationFeature.preParse!(json, binChunk);
        expect(outView).toBeDefined();
        expect(json.accessors[0].componentType).toBe(FLOAT);
        expect(json.accessors[0].normalized).toBe(false);
        const newBv = json.bufferViews[json.accessors[0].bufferView];
        expect(readFloats(outView!, newBv.byteOffset, 4)).toEqual([0, 65535, 100, 200]);
    });

    it("preserves normalized UNSIGNED_SHORT VEC2 TEXCOORD_0 behavior (base glTF, [0,1] scaling)", async () => {
        const buf = new ArrayBuffer(8);
        new Uint16Array(buf).set([0, 65535, 100, 200]);
        const binChunk = new DataView(buf);
        const json: any = {
            accessors: [{ bufferView: 0, componentType: UNSIGNED_SHORT, count: 2, type: "VEC2", normalized: true }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8, byteStride: 4 }],
        };

        const outView = await quantizationFeature.preParse!(json, binChunk);
        expect(outView).toBeDefined();
        expect(json.accessors[0].componentType).toBe(FLOAT);
        const newBv = json.bufferViews[json.accessors[0].bufferView];
        const values = readFloats(outView!, newBv.byteOffset, 4);
        expect(values[0]).toBeCloseTo(0, 6);
        expect(values[1]).toBeCloseTo(1, 6);
        expect(values[2]).toBeCloseTo(100 / 65535, 6);
        expect(values[3]).toBeCloseTo(200 / 65535, 6);
    });

    it("rewrites a STRIDED unnormalized UNSIGNED_SHORT VEC3 POSITION to FLOAT (pre-existing BrainStem/Duck case)", async () => {
        // 1 vertex, VEC3 UNSIGNED_SHORT padded to byteStride 8 (6 bytes of data + 2 bytes padding).
        const buf = new ArrayBuffer(8);
        new Uint16Array(buf).set([10, 20, 30]);
        const binChunk = new DataView(buf);
        const json: any = {
            accessors: [{ bufferView: 0, componentType: UNSIGNED_SHORT, count: 1, type: "VEC3" }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8, byteStride: 8 }],
        };

        const outView = await quantizationFeature.preParse!(json, binChunk);
        expect(outView).toBeDefined();
        expect(json.accessors[0].componentType).toBe(FLOAT);
        const newBv = json.bufferViews[json.accessors[0].bufferView];
        expect(readFloats(outView!, newBv.byteOffset, 3)).toEqual([10, 20, 30]);
    });

    it("does NOT rewrite unnormalized UNSIGNED_SHORT SCALAR indices", async () => {
        const buf = new ArrayBuffer(6);
        new Uint16Array(buf).set([0, 1, 2]);
        const binChunk = new DataView(buf);
        const json: any = {
            accessors: [{ bufferView: 0, componentType: UNSIGNED_SHORT, count: 3, type: "SCALAR" }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 6 }],
        };

        const outView = await quantizationFeature.preParse!(json, binChunk);
        expect(outView).toBeUndefined();
        expect(json.accessors[0].componentType).toBe(UNSIGNED_SHORT);
    });

    it("does NOT rewrite unnormalized UNSIGNED_BYTE VEC4 JOINTS_0", async () => {
        const buf = new ArrayBuffer(4);
        new Uint8Array(buf).set([0, 1, 2, 3]);
        const binChunk = new DataView(buf);
        const json: any = {
            accessors: [{ bufferView: 0, componentType: UNSIGNED_BYTE, count: 1, type: "VEC4" }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
        };

        const outView = await quantizationFeature.preParse!(json, binChunk);
        expect(outView).toBeUndefined();
        expect(json.accessors[0].componentType).toBe(UNSIGNED_BYTE);
    });

    it("returns undefined (no-op) when nothing needs conversion", async () => {
        const buf = new ArrayBuffer(8);
        const binChunk = new DataView(buf);
        const json: any = {
            accessors: [{ bufferView: 0, componentType: FLOAT, count: 2, type: "VEC2" }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }],
        };
        expect(await quantizationFeature.preParse!(json, binChunk)).toBeUndefined();
    });
});
