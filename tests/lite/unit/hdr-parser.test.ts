import { describe, expect, it } from "vitest";

import { parseRGBE } from "../../../packages/babylon-lite/src/loader-hdr/hdr-parser.js";

function makeHdr(width: number, body: number[]): ArrayBuffer {
    const header = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X ${width}\n`);
    const bytes = new Uint8Array(header.length + body.length);
    bytes.set(header);
    bytes.set(body, header.length);
    return bytes.buffer;
}

describe("HDR parser", () => {
    it("decodes a valid RLE scanline", () => {
        const image = parseRGBE(makeHdr(8, [2, 2, 0, 8, 136, 1, 136, 2, 136, 3, 136, 129]));

        expect(image.width).toBe(8);
        expect(image.height).toBe(1);
        expect(Array.from(image.data)).toEqual(Array.from({ length: 8 }, () => [1 / 128, 2 / 128, 3 / 128]).flat());
    });

    it("decodes valid RLE literal packets", () => {
        const literal = (value: number): number[] => [8, ...Array<number>(8).fill(value)];
        const image = parseRGBE(makeHdr(8, [2, 2, 0, 8, ...literal(1), ...literal(2), ...literal(3), ...literal(129)]));

        expect(Array.from(image.data)).toEqual(Array.from({ length: 8 }, () => [1 / 128, 2 / 128, 3 / 128]).flat());
    });

    it("decodes a valid flat scanline", () => {
        expect(Array.from(parseRGBE(makeHdr(1, [1, 2, 3, 129])).data)).toEqual([1 / 128, 2 / 128, 3 / 128]);
    });

    it("rejects zero-length RLE packets", () => {
        expect(() => parseRGBE(makeHdr(8, [2, 2, 0, 8, 0]))).toThrow("zero-length RLE packet");
    });

    it("rejects RLE scanlines whose encoded width does not match the image", () => {
        expect(() => parseRGBE(makeHdr(8, [2, 2, 0, 9]))).toThrow("RLE scanline width");
    });

    it("rejects RLE runs that exceed the scanline", () => {
        expect(() => parseRGBE(makeHdr(8, [2, 2, 0, 8, 137, 1]))).toThrow("RLE run exceeds scanline");
    });

    it("rejects truncated RLE runs", () => {
        expect(() => parseRGBE(makeHdr(8, [2, 2, 0, 8, 136]))).toThrow("RLE run exceeds scanline");
    });

    it("rejects truncated RLE literals", () => {
        expect(() => parseRGBE(makeHdr(8, [2, 2, 0, 8, 8, 1, 2]))).toThrow("RLE literal exceeds scanline");
    });

    it("rejects truncated flat scanlines", () => {
        expect(() => parseRGBE(makeHdr(1, []))).toThrow("truncated scanline");
    });
});
