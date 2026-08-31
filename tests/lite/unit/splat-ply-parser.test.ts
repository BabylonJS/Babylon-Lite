import { describe, expect, it } from "vitest";

import { convertCompressedPlyToParsedSplat } from "../../../packages/babylon-lite/src/loader-splat/splat-ply-compressed.js";
import { convertPlyToSplat, isPly, isPlyCompressedOrSH } from "../../../packages/babylon-lite/src/loader-splat/splat-ply-parser.js";

function combine(header: string, body: Uint8Array = new Uint8Array()): ArrayBuffer {
    const headerBytes = new TextEncoder().encode(header);
    const bytes = new Uint8Array(headerBytes.length + body.length);
    bytes.set(headerBytes);
    bytes.set(body, headerBytes.length);
    return bytes.buffer;
}

function makePositionPly(newline: "\n" | "\r\n", compressed = false): ArrayBuffer {
    const body = new Uint8Array(12);
    const values = new DataView(body.buffer);
    values.setFloat32(0, 1, true);
    values.setFloat32(4, 2, true);
    values.setFloat32(8, 3, true);
    const header = [
        "ply",
        "format binary_little_endian 1.0",
        ...(compressed ? ["element chunk 0"] : []),
        "element vertex 1",
        "property float x",
        "property float y",
        "property float z",
        "end_header",
        "",
    ].join(newline);
    return combine(header, body);
}

describe("PLY parser", () => {
    it.each(["\n", "\r\n"] as const)("parses standard PLY headers using %j line endings", (newline) => {
        const data = makePositionPly(newline);

        expect(isPly(data)).toBe(true);
        expect(Array.from(new Float32Array(convertPlyToSplat(data).data, 0, 3))).toEqual([1, 2, 3]);
    });

    it("routes and parses compressed PLY files with CRLF headers", () => {
        const data = makePositionPly("\r\n", true);

        expect(isPly(data)).toBe(true);
        expect(isPlyCompressedOrSH(data)).toBe(true);
        expect(Array.from(new Float32Array(convertCompressedPlyToParsedSplat(data).data, 0, 3))).toEqual([1, 2, 3]);
    });
});
