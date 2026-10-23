import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { computeMinMax, createBufferBuilder } from "../../../../packages/babylon-lite/src/export-gltf/export-buffers";
import { frameGlb } from "../../../../packages/babylon-lite/src/export-gltf/export-glb";
import { crc32, encodePng } from "../../../../packages/babylon-lite/src/export-gltf/export-png";
import { decodePng } from "./export-test-utils";

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;

function createRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function filled(length: number, start: number): Uint8Array {
    return Uint8Array.from({ length }, (_, i) => start + i);
}

describe("createBufferBuilder", () => {
    it("orders views by descending alignment need, stably, with no padding", () => {
        const b = createBufferBuilder();
        // Index: length (alignment): 0:3 (1), 1:2 (2), 2:4 (4), 3:6 (2), 4:1 (1), 5:8 (4)
        const lengths = [3, 2, 4, 6, 1, 8];
        const starts = [10, 20, 30, 40, 50, 60];
        lengths.forEach((n, i) => b.addBufferView(filled(n, starts[i]!)));
        const bin = b.finalize();

        expect(bin.byteLength).toBe(24);
        const offsets = b.bufferViews.map((v) => v.byteOffset ?? 0);
        // 4-aligned views (2, 5) first, then 2-aligned (1, 3), then odd (0, 4), each group in insertion order.
        expect(offsets).toEqual([20, 12, 0, 14, 23, 4]);
        lengths.forEach((n, i) => {
            expect(Array.from(bin.subarray(offsets[i]!, offsets[i]! + n))).toEqual(Array.from(filled(n, starts[i]!)));
            expect(b.bufferViews[i]!.byteLength).toBe(n);
            expect(b.bufferViews[i]!.buffer).toBe(0);
        });
    });

    it("keeps insertion order within an alignment class when everything is 4-aligned", () => {
        const b = createBufferBuilder();
        b.addBufferView(filled(4, 0));
        b.addBufferView(filled(8, 4));
        b.addBufferView(filled(4, 12));
        const bin = b.finalize();
        expect(b.bufferViews.map((v) => v.byteOffset ?? 0)).toEqual([0, 4, 12]);
        expect(Array.from(bin)).toEqual(Array.from(filled(16, 0)));
    });

    it("places every view at an offset satisfying its component alignment", () => {
        const b = createBufferBuilder();
        const random = createRandom(42);
        const arrays: ArrayBufferView[] = [];
        for (let i = 0; i < 40; i++) {
            const kind = Math.floor(random() * 3);
            const n = 1 + Math.floor(random() * 7);
            arrays.push(kind === 0 ? new Float32Array(n) : kind === 1 ? new Uint16Array(n) : new Uint8Array(n));
        }
        arrays.forEach((a) => b.addBufferView(a));
        b.finalize();
        b.bufferViews.forEach((view, i) => {
            const alignment = arrays[i]!.constructor === Float32Array ? 4 : arrays[i]!.constructor === Uint16Array ? 2 : 1;
            expect((view.byteOffset ?? 0) % alignment).toBe(0);
        });
    });

    it("omits byteOffset on the view placed at offset 0 and writes it on the others", () => {
        const b = createBufferBuilder();
        b.addBufferView(filled(4, 0));
        b.addBufferView(filled(4, 4));
        b.finalize();
        expect("byteOffset" in b.bufferViews[0]!).toBe(false);
        expect(b.bufferViews[1]!.byteOffset).toBe(4);
    });

    it("omits byteOffset on the first placed view even when it was not added first", () => {
        const b = createBufferBuilder();
        b.addBufferView(filled(1, 0));
        b.addBufferView(filled(4, 1));
        b.finalize();
        expect("byteOffset" in b.bufferViews[1]!).toBe(false);
        expect(b.bufferViews[0]!.byteOffset).toBe(4);
    });

    it("returns the same index for the same array object and target", () => {
        const b = createBufferBuilder();
        const data = new Float32Array([1, 2, 3, 4]);
        const first = b.addBufferView(data, ARRAY_BUFFER);
        expect(b.addBufferView(data, ARRAY_BUFFER)).toBe(first);
        expect(b.bufferViews).toHaveLength(1);
        // A different target is a different view of the same bytes.
        const otherTarget = b.addBufferView(data, ELEMENT_ARRAY_BUFFER);
        const noTarget = b.addBufferView(data);
        expect(new Set([first, otherTarget, noTarget]).size).toBe(3);
        expect(b.addBufferView(data)).toBe(noTarget);
        // An equal-content but distinct array is a distinct view.
        expect(b.addBufferView(new Float32Array([1, 2, 3, 4]), ARRAY_BUFFER)).not.toBe(first);
    });

    it("writes target only when given", () => {
        const b = createBufferBuilder();
        b.addBufferView(new Float32Array(2));
        b.addBufferView(new Uint16Array(2), ELEMENT_ARRAY_BUFFER);
        expect(Object.keys(b.bufferViews[0]!).sort()).toEqual(["buffer", "byteLength"]);
        expect(b.bufferViews[1]).toEqual({ buffer: 0, byteLength: 4, target: ELEMENT_ARRAY_BUFFER });
    });

    it("snapshots the payload: later writes to the source do not change finalize()", () => {
        const b = createBufferBuilder();
        const data = new Float32Array([1, 2, 3, 4]);
        b.addBufferView(data);
        data.fill(99);
        const bin = b.finalize();
        expect(Array.from(new Float32Array(bin.buffer, bin.byteOffset, 4))).toEqual([1, 2, 3, 4]);
    });

    it("copies only the bytes of a sub-view of a larger buffer", () => {
        const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const b = createBufferBuilder();
        b.addBufferView(backing.subarray(2, 6));
        expect(Array.from(b.finalize())).toEqual([3, 4, 5, 6]);
        expect(b.bufferViews[0]!.byteLength).toBe(4);
    });

    it("returns an empty payload when nothing was added", () => {
        expect(createBufferBuilder().finalize().byteLength).toBe(0);
    });

    it("writes accessor optional members only when given", () => {
        const b = createBufferBuilder();
        const view = b.addBufferView(new Float32Array(6));
        const minimal = b.addAccessor({ bufferView: view, componentType: FLOAT, count: 2, type: "VEC3" });
        expect(b.accessors[minimal]).toEqual({ bufferView: view, componentType: FLOAT, count: 2, type: "VEC3" });
        expect(Object.keys(b.accessors[minimal]!).sort()).toEqual(["bufferView", "componentType", "count", "type"]);

        const full = b.addAccessor({ bufferView: view, componentType: 5121, count: 1, type: "VEC3", min: [0, 0, 0], max: [1, 1, 1] });
        expect(b.accessors[full]).toEqual({ bufferView: view, componentType: 5121, count: 1, type: "VEC3", min: [0, 0, 0], max: [1, 1, 1] });
        expect(full).toBe(1);
    });
});

describe("computeMinMax", () => {
    it("computes per-component extremes", () => {
        expect(computeMinMax([1, 5, -2, 0, 9, 3], 3)).toEqual({ min: [0, 5, -2], max: [1, 9, 3] });
    });

    it("limits itself to `count` elements when given", () => {
        expect(computeMinMax([1, 1, 5, 5, 100, 100], 2, 2)).toEqual({ min: [1, 1], max: [5, 5] });
    });

    it("handles a single component and typed arrays", () => {
        expect(computeMinMax(new Float32Array([3, -1, 2]), 1)).toEqual({ min: [-1], max: [3] });
    });

    it("returns zeros for zero elements", () => {
        expect(computeMinMax([], 3)).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
    });
});

describe("frameGlb", () => {
    function chunks(glb: Uint8Array): {
        header: [number, number, number];
        json: { length: number; type: number; bytes: Uint8Array };
        bin: { length: number; type: number; bytes: Uint8Array };
    } {
        const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
        const jsonLength = view.getUint32(12, true);
        const binOffset = 20 + jsonLength;
        const binLength = view.getUint32(binOffset, true);
        return {
            header: [view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true)],
            json: { length: jsonLength, type: view.getUint32(16, true), bytes: glb.subarray(20, 20 + jsonLength) },
            bin: { length: binLength, type: view.getUint32(binOffset + 4, true), bytes: glb.subarray(binOffset + 8, binOffset + 8 + binLength) },
        };
    }

    it("writes the magic, version and total length", () => {
        const glb = frameGlb('{"asset":{"version":"2.0"}}', new Uint8Array([1, 2, 3, 4]));
        const { header } = chunks(glb);
        expect(header[0]).toBe(0x46546c67);
        expect(String.fromCharCode(...glb.subarray(0, 4))).toBe("glTF");
        expect(header[1]).toBe(2);
        expect(header[2]).toBe(glb.byteLength);
    });

    it("types the chunks JSON and BIN\\0", () => {
        const c = chunks(frameGlb("{}", new Uint8Array([1, 2, 3, 4])));
        expect(c.json.type).toBe(0x4e4f534a);
        expect(c.bin.type).toBe(0x004e4942);
    });

    it("pads the JSON chunk with 0x20 to a multiple of 4", () => {
        for (const json of ["{}", "{ }", '{"a":1}', '{"a":12}']) {
            const c = chunks(frameGlb(json, new Uint8Array(0)));
            const bytes = new TextEncoder().encode(json);
            expect(c.json.length % 4).toBe(0);
            expect(c.json.length).toBe(Math.ceil(bytes.length / 4) * 4);
            expect(Array.from(c.json.bytes.subarray(0, bytes.length))).toEqual(Array.from(bytes));
            expect(Array.from(c.json.bytes.subarray(bytes.length)).every((v) => v === 0x20)).toBe(true);
        }
    });

    it("measures the JSON chunk in UTF-8 bytes, not characters", () => {
        const json = '{"name":"é€"}';
        const c = chunks(frameGlb(json, new Uint8Array(0)));
        const bytes = new TextEncoder().encode(json);
        expect(bytes.length).toBeGreaterThan(json.length);
        expect(c.json.length).toBe(Math.ceil(bytes.length / 4) * 4);
    });

    it("pads the BIN chunk with zeros to a multiple of 4", () => {
        for (const n of [1, 2, 3, 4, 5]) {
            const bin = new Uint8Array(n).fill(0xff);
            const glb = frameGlb("{}", bin);
            const c = chunks(glb);
            expect(c.bin.length).toBe(Math.ceil(n / 4) * 4);
            expect(Array.from(c.bin.bytes.subarray(0, n))).toEqual(Array.from(bin));
            expect(Array.from(c.bin.bytes.subarray(n)).every((v) => v === 0)).toBe(true);
            expect(glb.byteLength).toBe(12 + 8 + c.json.length + 8 + c.bin.length);
        }
    });

    it("still writes a zero-length BIN chunk when the payload is empty", () => {
        const glb = frameGlb("{}", new Uint8Array(0));
        const c = chunks(glb);
        expect(c.bin.length).toBe(0);
        expect(c.bin.type).toBe(0x004e4942);
        expect(glb.byteLength).toBe(12 + 8 + 4 + 8);
    });
});

describe("crc32", () => {
    it("matches zlib.crc32 on random bytes", () => {
        const random = createRandom(2718);
        for (const n of [0, 1, 7, 64, 1000]) {
            const bytes = Uint8Array.from({ length: n }, () => Math.floor(random() * 256));
            expect(crc32(bytes)).toBe(zlibCrc32(bytes));
        }
    });

    it("honours the start and end range", () => {
        const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
        expect(crc32(bytes, 5, 20)).toBe(zlibCrc32(bytes.subarray(5, 20)));
    });

    it("matches the well-known check value", () => {
        expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    });
});

describe("encodePng", () => {
    function rgbaFor(width: number, height: number, seed: number): Uint8Array {
        const random = createRandom(seed);
        return Uint8Array.from({ length: width * height * 4 }, () => Math.floor(random() * 256));
    }

    function readChunks(png: Uint8Array): { type: string; data: Uint8Array; crc: number; crcRange: Uint8Array }[] {
        const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
        const out = [];
        let offset = 8;
        while (offset < png.length) {
            const length = view.getUint32(offset);
            out.push({
                type: String.fromCharCode(...png.subarray(offset + 4, offset + 8)),
                data: png.subarray(offset + 8, offset + 8 + length),
                crc: view.getUint32(offset + 8 + length),
                crcRange: png.subarray(offset + 4, offset + 8 + length),
            });
            offset += 12 + length;
        }
        return out;
    }

    it("round-trips odd sizes through decodePng", async () => {
        for (const [w, h] of [
            [3, 5],
            [1, 1],
            [5, 3],
            [7, 1],
            [1, 9],
        ] as const) {
            const rgba = rgbaFor(w, h, w * 31 + h);
            const decoded = await decodePng(await encodePng(w, h, rgba));
            expect(decoded.width).toBe(w);
            expect(decoded.height).toBe(h);
            expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba));
        }
    });

    it("writes the PNG signature", async () => {
        const png = await encodePng(3, 5, rgbaFor(3, 5, 1));
        expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    });

    it("writes an 8-bit RGBA, non-interlaced IHDR", async () => {
        const png = await encodePng(3, 5, rgbaFor(3, 5, 2));
        const [ihdr] = readChunks(png);
        expect(ihdr!.type).toBe("IHDR");
        expect(ihdr!.data.byteLength).toBe(13);
        const view = new DataView(ihdr!.data.buffer, ihdr!.data.byteOffset, 13);
        expect(view.getUint32(0)).toBe(3);
        expect(view.getUint32(4)).toBe(5);
        expect(Array.from(ihdr!.data.subarray(8))).toEqual([8, 6, 0, 0, 0]);
    });

    it("emits IHDR, IDAT, IEND in order, each with a valid CRC over type + data", async () => {
        const png = await encodePng(3, 5, rgbaFor(3, 5, 3));
        const chunks = readChunks(png);
        expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
        expect(chunks[2]!.data.byteLength).toBe(0);
        for (const chunk of chunks) {
            expect(chunk.crc).toBe(zlibCrc32(chunk.crcRange));
        }
    });

    it("produces a zlib stream (RFC 1950 header) of filter-0 scanlines", async () => {
        const png = await encodePng(3, 5, rgbaFor(3, 5, 4));
        const idat = readChunks(png)[1]!.data;
        expect(idat[0]! & 0x0f).toBe(8);
        expect(((idat[0]! << 8) | idat[1]!) % 31).toBe(0);
    });
});
