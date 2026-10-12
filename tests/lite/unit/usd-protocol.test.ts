import { describe, expect, it } from "vitest";

import { readUsdCommands, UsdOp, usdBytes, usdField, usdFloats, usdString, usdU16, usdUints } from "../../../packages/babylon-lite/src/loader-usd/usd-protocol";
import { usdMatrix } from "../../../packages/babylon-lite/src/loader-usd/usd-nodes";
import { usdFixture } from "./usd-fixture";

describe("USD command protocol", () => {
    it("validates and exposes version-5 command records and typed data spans", () => {
        const fixture = usdFixture({ skin: true });
        const records = readUsdCommands(fixture.commands);

        expect(records.map((record) => record.op)).toContain(UsdOp.Scene);
        expect(records.map((record) => record.op)).toContain(UsdOp.Skeleton);
        const scene = records[0]!;
        expect(usdField(scene, 0)).toBe(0);
        expect(scene.payload.getFloat32(4, true)).toBe(1);

        const node = records.find((record) => record.op === UsdOp.Node)!;
        expect(usdString(fixture.data, usdField(node, 2), usdField(node, 3))).toBe("Fixture");
        expect(usdFloats(fixture.data, usdField(node, 4), 16)).toEqual(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));

        const geometry = records.find((record) => record.op === UsdOp.Geometry)!;
        expect(usdUints(fixture.data, usdField(geometry, 13), 6)).toEqual(new Uint32Array([0, 1, 2, 0, 2, 3]));
        expect(usdU16(fixture.data, usdField(geometry, 9), 4)).toEqual(new Uint16Array([0, 1, 0, 1]));
        expect(usdBytes(fixture.data, usdField(node, 2), 7)).toEqual(new TextEncoder().encode("Fixture"));
    });

    it.each([
        ["magic", (buffer: ArrayBuffer) => new DataView(buffer).setUint32(0, 0, true), "Invalid USD command buffer"],
        ["version", (buffer: ArrayBuffer) => new DataView(buffer).setUint16(4, 4, true), "Unsupported USD command protocol version"],
        ["payload size", (buffer: ArrayBuffer) => new DataView(buffer).setUint32(20, 11, true), "Invalid USD command 1 payload"],
        ["command count", (buffer: ArrayBuffer) => new DataView(buffer).setUint32(8, 100, true), "Truncated USD command header"],
    ])("rejects an invalid %s", (_label, mutate, error) => {
        const buffer = usdFixture().commands.slice(0);
        mutate(buffer);
        expect(() => readUsdCommands(buffer)).toThrow(error);
    });

    it("rejects trailing commands and unaligned or overflowing data ranges", () => {
        const fixture = usdFixture();
        const trailing = new Uint8Array(fixture.commands.byteLength + 1);
        trailing.set(new Uint8Array(fixture.commands));
        expect(() => readUsdCommands(trailing.buffer)).toThrow("Unexpected trailing USD commands");
        expect(() => usdFloats(fixture.data, 1, 1)).toThrow("Invalid USD data range");
        expect(() => usdUints(fixture.data, fixture.data.byteLength, 1)).toThrow("Invalid USD data range");
    });

    it("interprets Gf row-vector row-major bytes as the equivalent Lite column-vector matrix", () => {
        // Native GfMatrix: 90-degree Z rotation with translation in the last row.
        // The identical flat sequence is the transposed column-vector matrix Lite needs.
        const matrix = usdMatrix([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1]);
        expect([matrix[12], matrix[13], matrix[14]]).toEqual([4, 5, 6]);
        const x = matrix[0]! + matrix[12]!;
        const y = matrix[1]! + matrix[13]!;
        const z = matrix[2]! + matrix[14]!;
        expect([x, y, z]).toEqual([4, 6, 6]);
    });
});
