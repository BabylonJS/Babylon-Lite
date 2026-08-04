/**
 * `mat4LookAtWorldLHToRef` replaces the "build a view matrix with `mat4LookAtLH`, then
 * transpose its rotation back out and overwrite its translation with the eye" round-trip that
 * every camera factory used to do. These pin it to that former path element for element,
 * including both degenerate fallbacks, so the refactor cannot move a single pixel.
 */
import { describe, expect, it } from "vitest";

import { mat4LookAtLH } from "../../../packages/babylon-lite/src/math/mat4-look-at-lh";
import { mat4LookAtWorldLHToRef } from "../../../packages/babylon-lite/src/math/mat4-look-at-world-lh";
import type { Mat4Storage, Vec3 } from "../../../packages/babylon-lite/src/math/types";

/** The exact code the camera factories used to inline. */
function legacyCameraWorld(eye: Vec3, target: Vec3, up: Vec3): Float32Array {
    const v = mat4LookAtLH(eye, target, up);
    const m = new Float32Array(16);
    m[0] = v[0]!;
    m[1] = v[4]!;
    m[2] = v[8]!;
    m[3] = 0;
    m[4] = v[1]!;
    m[5] = v[5]!;
    m[6] = v[9]!;
    m[7] = 0;
    m[8] = v[2]!;
    m[9] = v[6]!;
    m[10] = v[10]!;
    m[11] = 0;
    m[12] = eye.x;
    m[13] = eye.y;
    m[14] = eye.z;
    m[15] = 1;
    return m;
}

function build(eye: Vec3, target: Vec3, up: Vec3): Float32Array {
    // Float32 storage, as `allocateMat4()` hands out for a non-HPM engine — so the
    // comparison against the (Float32-rounded) legacy path is exact.
    const out = new Float32Array(16).fill(-999);
    mat4LookAtWorldLHToRef(out as unknown as Mat4Storage, eye, target, up);
    return out;
}

const UP: Vec3 = { x: 0, y: 1, z: 0 };

describe("mat4LookAtWorldLHToRef", () => {
    const cases: [string, Vec3, Vec3, Vec3][] = [
        ["axis-aligned", { x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 0 }, UP],
        ["arbitrary orbit position", { x: 3.5, y: 7.25, z: -2.125 }, { x: -1, y: 0.5, z: 4 }, UP],
        ["off-origin target with tilted up", { x: -12, y: 3, z: 8 }, { x: 2, y: -6, z: -1 }, { x: 0.2, y: 0.9, z: -0.3 }],
        ["planet-scale eye (geospatial)", { x: 0, y: 6.5e6, z: 1.2e6 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }],
    ];

    for (const [name, eye, target, up] of cases) {
        it(`matches the former look-at round-trip — ${name}`, () => {
            expect(Array.from(build(eye, target, up))).toEqual(Array.from(legacyCameraWorld(eye, target, up)));
        });
    }

    it("writes every element", () => {
        expect(Array.from(build({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0 }, UP)).some((v) => v === -999)).toBe(false);
    });

    it("produces an orthonormal right-handed-in-LH basis", () => {
        const m = build({ x: 3.5, y: 7.25, z: -2.125 }, { x: -1, y: 0.5, z: 4 }, UP);
        const col = (i: number) => [m[i * 4]!, m[i * 4 + 1]!, m[i * 4 + 2]!];
        const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
        const [x, y, z] = [col(0), col(1), col(2)];

        expect(dot(x, x)).toBeCloseTo(1, 5);
        expect(dot(y, y)).toBeCloseTo(1, 5);
        expect(dot(z, z)).toBeCloseTo(1, 5);
        expect(dot(x, y)).toBeCloseTo(0, 5);
        expect(dot(x, z)).toBeCloseTo(0, 5);
        expect(dot(y, z)).toBeCloseTo(0, 5);
        // +Z column points from the eye towards the target.
        expect(dot(z, [-1 - 3.5, 0.5 - 7.25, 4 + 2.125])).toBeGreaterThan(0);
    });

    it("falls back to an identity rotation when the eye sits on the target", () => {
        const eye = { x: 4, y: 5, z: 6 };
        const m = build(eye, eye, UP);
        expect(Array.from(m)).toEqual(Array.from(legacyCameraWorld(eye, eye, UP)));
        expect(Array.from(m)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1]);
    });

    it("falls back to an identity rotation when the view direction is parallel to up", () => {
        const eye = { x: 0, y: 10, z: 0 };
        const target = { x: 0, y: 0, z: 0 };
        const m = build(eye, target, UP);
        expect(Array.from(m)).toEqual(Array.from(legacyCameraWorld(eye, target, UP)));
        expect(Array.from(m)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 10, 0, 1]);
    });

    it("leaves no stale rotation behind when a later call degenerates", () => {
        const out = new Float32Array(16) as unknown as Mat4Storage;
        mat4LookAtWorldLHToRef(out, { x: 3, y: 4, z: 5 }, { x: -2, y: 1, z: 0 }, UP);
        mat4LookAtWorldLHToRef(out, { x: 0, y: 10, z: 0 }, { x: 0, y: 0, z: 0 }, UP);
        expect(Array.from(out as unknown as Float32Array)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 10, 0, 1]);
    });
});
