import { describe, expect, it } from "vitest";
import {
    EXPORT_EPSILON,
    canonicalizeQuat,
    convertMatrix,
    convertRotation,
    convertTranslation,
    multiplyQuat,
    nearlyEqual,
    needsWindingFlip,
    normalizeQuat,
    rotate180Y,
    rotationToDirection,
} from "../../../../packages/babylon-lite/src/export-gltf/export-handedness";

type Quat = [number, number, number, number];

/** Seeded PRNG (mulberry32) so failures reproduce. */
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

function randomUnitQuat(random: () => number): Quat {
    for (;;) {
        const q: Quat = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1, random() * 2 - 1];
        const len = Math.hypot(...q);
        if (len > 0.1) {
            return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
        }
    }
}

/** Row-major 3×3 rotation matrix of a unit quaternion (acting on column vectors). */
function quatToMat3(q: Quat): number[][] {
    const [x, y, z, w] = q;
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ];
}

/** Shepperd's method. */
function mat3ToQuat(m: number[][]): Quat {
    const trace = m[0]![0]! + m[1]![1]! + m[2]![2]!;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        return [(m[2]![1]! - m[1]![2]!) / s, (m[0]![2]! - m[2]![0]!) / s, (m[1]![0]! - m[0]![1]!) / s, 0.25 * s];
    }
    if (m[0]![0]! > m[1]![1]! && m[0]![0]! > m[2]![2]!) {
        const s = Math.sqrt(1 + m[0]![0]! - m[1]![1]! - m[2]![2]!) * 2;
        return [0.25 * s, (m[0]![1]! + m[1]![0]!) / s, (m[0]![2]! + m[2]![0]!) / s, (m[2]![1]! - m[1]![2]!) / s];
    }
    if (m[1]![1]! > m[2]![2]!) {
        const s = Math.sqrt(1 + m[1]![1]! - m[0]![0]! - m[2]![2]!) * 2;
        return [(m[0]![1]! + m[1]![0]!) / s, 0.25 * s, (m[1]![2]! + m[2]![1]!) / s, (m[0]![2]! - m[2]![0]!) / s];
    }
    const s = Math.sqrt(1 + m[2]![2]! - m[0]![0]! - m[1]![1]!) * 2;
    return [(m[0]![2]! + m[2]![0]!) / s, (m[1]![2]! + m[2]![1]!) / s, 0.25 * s, (m[1]![0]! - m[0]![1]!) / s];
}

/** quat(C · mat(q) · C) with C = diag(−1, 1, 1), computed through real matrices. */
function referenceChangeOfBasis(q: Quat): Quat {
    const c = [-1, 1, 1];
    const m = quatToMat3(q);
    const out = m.map((row, r) => row.map((v, col) => c[r]! * v * c[col]!));
    return mat3ToQuat(out);
}

function expectSameRotation(actual: Quat, expected: Quat): void {
    const dot = actual[0] * expected[0] + actual[1] * expected[1] + actual[2] * expected[2] + actual[3] * expected[3];
    const sign = dot < 0 ? -1 : 1;
    for (let i = 0; i < 4; i++) {
        expect(actual[i]!).toBeCloseTo(sign * expected[i]!, 6);
    }
}

function rotateVector(q: Quat, v: [number, number, number]): [number, number, number] {
    const [x, y, z, w] = q;
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** The pivot component the Babylon.js sign rule inspects. */
function pivotOf(q: Quat): number {
    const [x, y, z, w] = q;
    if (x * x + y * y > 0.5) {
        return Math.abs(x) > Math.abs(y) ? x : y;
    }
    return Math.abs(z) > Math.abs(w) ? z : w;
}

describe("convertRotation", () => {
    it("equals ±quat(C·mat(q)·C) over seeded random unit quaternions", () => {
        const random = createRandom(12345);
        for (let i = 0; i < 200; i++) {
            const q = randomUnitQuat(random);
            expectSameRotation(convertRotation(...q), referenceChangeOfBasis(q));
        }
    });

    it("returns unit quaternions with a non-negative pivot component", () => {
        const random = createRandom(777);
        for (let i = 0; i < 200; i++) {
            const result = convertRotation(...randomUnitQuat(random));
            expect(Math.hypot(...result)).toBeCloseTo(1, 6);
            expect(pivotOf(result)).toBeGreaterThanOrEqual(0);
        }
    });

    it("keeps a 90° rotation about X and about Y consistent with the matrix reference", () => {
        const s = Math.SQRT1_2;
        for (const q of [
            [s, 0, 0, s],
            [-s, 0, 0, -s],
            [0, s, 0, s],
            [0, -s, 0, -s],
        ] as Quat[]) {
            // x² + y² sits exactly on the 0.5 pivot-family boundary here, so only the rotation is asserted.
            expectSameRotation(convertRotation(...q), referenceChangeOfBasis(q));
        }
    });

    it("breaks an exact |x| = |y| tie toward y (negating when y is negative)", () => {
        // Mirrored input is (0.6, −0.6, ...): x² + y² = 0.72 > 0.5 and |x| = |y|. Picking y (−0.6) negates the quaternion; picking x (0.6) would not.
        const z = 0.4;
        const w = Math.sqrt(1 - 0.72 - z * z);
        const result = convertRotation(0.6, 0.6, z, w);
        expect(result[0]).toBeCloseTo(-0.6, 9);
        expect(result[1]).toBeCloseTo(0.6, 9);
        expect(result[2]).toBeCloseTo(z, 9);
        expect(result[3]).toBeCloseTo(-w, 9);
    });

    it("breaks an exact |z| = |w| tie toward w", () => {
        // Mirrored input is (0, 0, −s, s): picking w (+s) keeps the sign; picking z (−s) would negate it.
        const s = Math.SQRT1_2;
        const result = convertRotation(0, 0, s, s);
        expect(result[2]).toBeCloseTo(-s, 9);
        expect(result[3]).toBeCloseTo(s, 9);
        // With w negative the tie picks w and negates.
        const negated = convertRotation(0, 0, s, -s);
        expect(negated[2]).toBeCloseTo(s, 9);
        expect(negated[3]).toBeCloseTo(s, 9);
    });

    it("maps the identity to the identity", () => {
        const q = convertRotation(0, 0, 0, 1);
        expect(q.map((v) => v + 0)).toEqual([0, 0, 0, 1]);
    });
});

describe("convertTranslation", () => {
    it("negates X only", () => {
        expect(convertTranslation(1, 2, 3)).toEqual([-1, 2, 3]);
    });
});

describe("convertMatrix", () => {
    it("equals C·M·C element by element", () => {
        const random = createRandom(2024);
        const m = Array.from({ length: 16 }, () => random() * 10 - 5);
        const c = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        const mul = (a: number[], b: number[]): number[] => {
            const out = new Array<number>(16).fill(0);
            for (let col = 0; col < 4; col++) {
                for (let row = 0; row < 4; row++) {
                    for (let k = 0; k < 4; k++) {
                        out[col * 4 + row]! += a[k * 4 + row]! * b[col * 4 + k]!;
                    }
                }
            }
            return out;
        };
        const expected = mul(mul(c, m), c);
        const actual = convertMatrix(m);
        for (let i = 0; i < 16; i++) {
            expect(actual[i]!).toBeCloseTo(expected[i]! + 0, 12);
        }
    });

    it("negates exactly the entries where one of row and column is 0 and does not mutate its input", () => {
        const m = Array.from({ length: 16 }, (_, i) => i + 1);
        const copy = m.slice();
        const out = convertMatrix(m);
        for (let i = 0; i < 16; i++) {
            const row = i % 4;
            const col = Math.floor(i / 4);
            expect(out[i]).toBe((row === 0) !== (col === 0) ? -m[i]! : m[i]!);
        }
        expect(m).toEqual(copy);
    });

    it("accepts a Float32Array", () => {
        const out = convertMatrix(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]));
        expect(out.slice(12)).toEqual([-5, 6, 7, 1]);
    });
});

describe("rotate180Y", () => {
    it("maps (x, y, z, w) to (−z, w, x, −y)", () => {
        expect(rotate180Y(1, 2, 3, 4)).toEqual([-3, 4, 1, -2]);
    });

    it("equals q ⊗ (0, 1, 0, 0)", () => {
        const random = createRandom(5);
        for (let i = 0; i < 20; i++) {
            const q = randomUnitQuat(random);
            const expected = multiplyQuat(q, [0, 1, 0, 0]);
            const actual = rotate180Y(...q);
            for (let k = 0; k < 4; k++) {
                expect(actual[k]!).toBeCloseTo(expected[k]!, 12);
            }
        }
    });

    it("applied twice is the identity action (the quaternion negated)", () => {
        const random = createRandom(6);
        for (let i = 0; i < 20; i++) {
            const q = randomUnitQuat(random);
            const twice = rotate180Y(...rotate180Y(...q));
            expect(twice).toEqual([-q[0], -q[1], -q[2], -q[3]]);
            const v: [number, number, number] = [0.3, -1.2, 2.5];
            const a = rotateVector(twice, v);
            const b = rotateVector(q, v);
            for (let k = 0; k < 3; k++) {
                expect(a[k]!).toBeCloseTo(b[k]!, 9);
            }
        }
    });
});

describe("rotationToDirection", () => {
    it("rotates (0, 0, −1) onto the normalized direction for random directions", () => {
        const random = createRandom(31337);
        for (let i = 0; i < 100; i++) {
            const d: [number, number, number] = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1];
            const len = Math.hypot(...d);
            if (len < 0.05) {
                continue;
            }
            const q = rotationToDirection(...d);
            expect(Math.hypot(...q)).toBeCloseTo(1, 6);
            const out = rotateVector(q, [0, 0, -1]);
            for (let k = 0; k < 3; k++) {
                expect(out[k]!).toBeCloseTo(d[k]! / len, 6);
            }
        }
    });

    it("resolves the antiparallel direction (0, 0, 1) to a 180° yaw", () => {
        expect(rotationToDirection(0, 0, 1)).toEqual([0, 1, 0, 0]);
        expect(rotationToDirection(0, 0, 5)).toEqual([0, 1, 0, 0]);
    });

    it("returns the identity for d = (0, 0, −1) and for a zero-length direction", () => {
        const forward = rotationToDirection(0, 0, -1);
        expect(forward[0]).toBeCloseTo(0, 9);
        expect(forward[1]).toBeCloseTo(0, 9);
        expect(forward[2]).toBeCloseTo(0, 9);
        expect(Math.abs(forward[3])).toBeCloseTo(1, 9);
        expect(rotationToDirection(0, 0, 0)).toEqual([0, 0, 0, 1]);
    });
});

describe("needsWindingFlip", () => {
    it.each([
        [1, true, false],
        [undefined, true, false],
        [-1, true, true],
        [1, false, true],
        [undefined, false, true],
        [-1, false, false],
    ] as const)("authoredSign %s, convert %s -> %s", (sign, convert, expected) => {
        expect(needsWindingFlip(sign, convert)).toBe(expected);
    });
});

describe("nearlyEqual", () => {
    it("accepts differences up to exactly the epsilon and rejects larger ones", () => {
        expect(EXPORT_EPSILON).toBe(0.001);
        expect(nearlyEqual([EXPORT_EPSILON], [0])).toBe(true);
        expect(nearlyEqual([-EXPORT_EPSILON], [0])).toBe(true);
        expect(nearlyEqual([EXPORT_EPSILON * 0.99], [0])).toBe(true);
        expect(nearlyEqual([EXPORT_EPSILON * 1.01], [0])).toBe(false);
        expect(nearlyEqual([-EXPORT_EPSILON * 1.01], [0])).toBe(false);
    });

    it("requires every component to be within epsilon", () => {
        expect(nearlyEqual([0, 0, 0.0005], [0, 0, 0])).toBe(true);
        expect(nearlyEqual([0, 0.5, 0], [0, 0, 0])).toBe(false);
    });

    it("rejects NaN", () => {
        expect(nearlyEqual([NaN], [0])).toBe(false);
    });
});

describe("canonicalizeQuat and normalizeQuat", () => {
    it("normalizes the quaternion", () => {
        expect(canonicalizeQuat(0, 0, 0, 2)).toEqual([0, 0, 0, 1]);
        const q = canonicalizeQuat(1, 2, 3, 4);
        expect(Math.hypot(...q)).toBeCloseTo(1, 12);
    });

    it("negates a quaternion whose pivot is negative", () => {
        expect(canonicalizeQuat(0, 0, 0, -2)).toEqual([-0, -0, -0, 1]);
        const q = canonicalizeQuat(0, 0, -0.6, -0.8);
        expect(q[2]).toBeCloseTo(0.6, 12);
        expect(q[3]).toBeCloseTo(0.8, 12);
        const high = canonicalizeQuat(-0.9, 0.1, 0, -0.1);
        expect(high[0]).toBeGreaterThan(0);
    });

    it("normalizeQuat turns a zero quaternion into the identity", () => {
        expect(normalizeQuat(0, 0, 0, 0)).toEqual([0, 0, 0, 1]);
        expect(normalizeQuat(0, 3, 0, 4)).toEqual([0, 0.6, 0, 0.8]);
    });

    it("normalizeQuat returns a quaternion within the tolerance of unit length verbatim", () => {
        const near: Quat = [0, 0, 0, 1 + 5e-7];
        expect(normalizeQuat(...near, 1e-6)).toEqual(near);
        expect(normalizeQuat(...near)).toEqual([0, 0, 0, 1]);
        expect(normalizeQuat(0, 0, 0, 1.01, 1e-6)).toEqual([0, 0, 0, 1]);
    });
});
