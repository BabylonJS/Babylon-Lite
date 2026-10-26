import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { computeMinMax, createBufferBuilder } from "../../../../packages/babylon-lite/src/export-gltf/export-buffers";
import { frameGlb } from "../../../../packages/babylon-lite/src/export-gltf/export-glb";
import { encodePng } from "../../../../packages/babylon-lite/src/export-gltf/export-png";
import { decodePng, parseGlb } from "./export-test-utils";

describe("binary encoding", () => {
    it("packs aligned subviews, deduplicates by identity/target and snapshots their bytes", () => {
        const builder = createBufferBuilder();
        const arrays = [new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4), new Uint16Array([4]), new Float32Array([5, 6])];
        const expected = arrays.map((array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength).slice());
        for (const array of arrays) {
            const index = builder.addBufferView(array, 34962);
            expect(builder.addBufferView(array, 34962)).toBe(index);
        }
        expect(builder.addBufferView(arrays[0]!, 34963)).toBe(3);
        expect(builder.addBufferView(arrays[0]!.slice(), 34962)).toBe(4);
        arrays[0]!.fill(0);
        const bin = builder.finalize();
        for (const [i, array] of arrays.entries()) {
            const view = builder.bufferViews[i]!;
            expect((view.byteOffset ?? 0) % array.BYTES_PER_ELEMENT).toBe(0);
            expect(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)).toEqual(expected[i]);
        }
    });

    it.each([
        { values: [1, 5, -2, 0, 9, 3], components: 3, count: 2, expected: { min: [0, 5, -2], max: [1, 9, 3] } },
        { values: [1, 1, 5, 5, 100, 100], components: 2, count: 2, expected: { min: [1, 1], max: [5, 5] } },
        { values: [], components: 3, count: 0, expected: { min: [0, 0, 0], max: [0, 0, 0] } },
    ])("computes bounds for $count elements", ({ values, components, count, expected }) => {
        expect(computeMinMax(values, components, count)).toEqual(expected);
    });

    it.each([0, 1, 5])("frames UTF-8 JSON and %s BIN bytes without copying the payload", async (length) => {
        const json = JSON.stringify({ name: "\u{1f600}" });
        const bin = new Uint8Array(length).fill(0xff);
        const parts = frameGlb(json, bin);
        expect(parts).toContain(bin);
        const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
        const parsed = parseGlb(bytes);
        expect(parsed.json.name).toBe("\u{1f600}");
        const view = new DataView(bytes.buffer);
        const jsonBytes = new TextEncoder().encode(json);
        const jsonLength = view.getUint32(12, true);
        expect(jsonLength).toBe(Math.ceil(jsonBytes.length / 4) * 4);
        expect(Array.from(bytes.subarray(20 + jsonBytes.length, 20 + jsonLength))).toEqual(new Array(jsonLength - jsonBytes.length).fill(0x20));
        expect(parsed.bin.length).toBe(Math.ceil(length / 4) * 4);
        expect(parsed.bin.subarray(0, length)).toEqual(bin);
        expect(Array.from(parsed.bin.subarray(length))).toEqual(new Array(parsed.bin.length - length).fill(0));
    });

    it.each([
        [1, 1],
        [3, 5],
    ])("writes valid PNG chunks and round-trips %sx%s RGBA pixels", async (width, height) => {
        const rgba = Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 17) % 256);
        const png = await encodePng(width, height, rgba);
        expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
        const types: string[] = [];
        for (let offset = 8; offset < png.length;) {
            const size = view.getUint32(offset);
            types.push(new TextDecoder().decode(png.subarray(offset + 4, offset + 8)));
            expect(view.getUint32(offset + 8 + size)).toBe(zlibCrc32(png.subarray(offset + 4, offset + 8 + size)));
            offset += size + 12;
        }
        expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
        expect(Array.from(png.subarray(24, 29))).toEqual([8, 6, 0, 0, 0]);
        expect(await decodePng(png)).toEqual({ width, height, rgba });
    });
});
