import { describe, expect, it } from "vitest";

import { writeMat4FromLookDirectionLHIntoBuffer, writeMat4FromLookDirectionRHIntoBuffer } from "../../../packages/babylon-lite/src/math/write-mat4-from-look-direction-into-buffer";

describe("look-direction matrices", () => {
    it("writes the left-handed identity orientation into caller-owned storage", () => {
        const out = new Float32Array(16).fill(7);
        expect(writeMat4FromLookDirectionLHIntoBuffer(out, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 })).toBe(out);
        expect([...out]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    });

    it("writes the right-handed identity orientation into caller-owned storage", () => {
        const out = new Float64Array(16).fill(7);
        expect(writeMat4FromLookDirectionRHIntoBuffer(out, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 })).toBe(out);
        expect([...out]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].map((value) => expect.closeTo(value)));
    });

    it("maps the handedness-specific local forward axis to the requested direction", () => {
        const lh = writeMat4FromLookDirectionLHIntoBuffer(new Float32Array(16), { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
        const rh = writeMat4FromLookDirectionRHIntoBuffer(new Float32Array(16), { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
        expect([lh[8], lh[9], lh[10]]).toEqual([1, 0, 0]);
        expect([-rh[8]!, -rh[9]!, -rh[10]!]).toEqual([1, 0, 0]);
    });
});
