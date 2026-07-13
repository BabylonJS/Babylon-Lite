import { describe, expect, it } from "vitest";

import type { MorphTargetData, SkeletonData } from "../../../packages/babylon-lite/src/animation/types";
import type { Vec3 } from "../../../packages/babylon-lite/src/math/types";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { computeDeformedPositionToRef } from "../../../packages/babylon-lite/src/picking/deformed-vertex";

// ── Column-major mat4 fixtures (translation is enough to exercise the skinning math) ──

function identityMat(): Float32Array {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}

function translationMat(x: number, y: number, z: number): Float32Array {
    const m = identityMat();
    m[12] = x;
    m[13] = y;
    m[14] = z;
    return m;
}

/** Concatenate per-bone 4x4 matrices into a single boneMatrices buffer. */
function concatMat(...mats: Float32Array[]): Float32Array {
    const out = new Float32Array(mats.length * 16);
    mats.forEach((m, i) => out.set(m, i * 16));
    return out;
}

function makeMorph(targets: number[][], weights: number[], count = targets.length): MorphTargetData {
    return {
        targets: targets.map((positions) => ({ positions: new Float32Array(positions), normals: null })),
        weights: new Float32Array(weights),
        count,
    } as unknown as MorphTargetData;
}

function makeSkeleton(o: { boneMatrices: Float32Array; joints: number[]; weights: number[]; joints1?: number[]; weights1?: number[] }): SkeletonData {
    return {
        boneMatrices: o.boneMatrices,
        joints: new Uint16Array(o.joints),
        weights: new Float32Array(o.weights),
        joints1: o.joints1 ? new Uint16Array(o.joints1) : null,
        weights1: o.weights1 ? new Float32Array(o.weights1) : null,
    } as unknown as SkeletonData;
}

function makeMesh(fields: Partial<Mesh>): Mesh {
    return fields as unknown as Mesh;
}

describe("computeDeformedPositionToRef", () => {
    it("returns the base position when there is no morph or skeleton", () => {
        const mesh = makeMesh({ _cpuPositions: new Float32Array([1, 2, 3, -4, 5, -6]) });
        const out: Vec3 = { x: 0, y: 0, z: 0 };

        expect(computeDeformedPositionToRef(mesh, 0, out)).toBe(true);
        expect(out).toEqual({ x: 1, y: 2, z: 3 });

        expect(computeDeformedPositionToRef(mesh, 1, out)).toBe(true);
        expect(out).toEqual({ x: -4, y: 5, z: -6 });
    });

    it("returns false and leaves out untouched when the mesh has no CPU positions", () => {
        const mesh = makeMesh({});
        const out: Vec3 = { x: 1, y: 1, z: 1 };

        expect(computeDeformedPositionToRef(mesh, 0, out)).toBe(false);
        expect(out).toEqual({ x: 1, y: 1, z: 1 });
    });

    it("returns false when the vertex index is out of range", () => {
        const mesh = makeMesh({ _cpuPositions: new Float32Array([0, 0, 0]) }); // one vertex

        expect(computeDeformedPositionToRef(mesh, 1, { x: 0, y: 0, z: 0 })).toBe(false);
        expect(computeDeformedPositionToRef(mesh, -1, { x: 0, y: 0, z: 0 })).toBe(false);
        // Boundary: the last valid vertex still resolves.
        expect(computeDeformedPositionToRef(mesh, 0, { x: 0, y: 0, z: 0 })).toBe(true);
    });

    it("applies weighted morph-target offsets", () => {
        const mesh = makeMesh({
            _cpuPositions: new Float32Array([0, 0, 0]),
            morphTargets: makeMorph(
                [
                    [10, 0, 0],
                    [0, 4, 0],
                ],
                [0.5, 0.25]
            ),
        });
        const out: Vec3 = { x: 0, y: 0, z: 0 };

        computeDeformedPositionToRef(mesh, 0, out);
        expect(out.x).toBeCloseTo(5); // 0 + 10 * 0.5
        expect(out.y).toBeCloseTo(1); // 0 + 4 * 0.25
        expect(out.z).toBeCloseTo(0);
    });

    it("skips morph targets whose weight is zero", () => {
        const mesh = makeMesh({
            _cpuPositions: new Float32Array([1, 1, 1]),
            morphTargets: makeMorph([[100, 100, 100]], [0]),
        });
        const out: Vec3 = { x: 0, y: 0, z: 0 };

        computeDeformedPositionToRef(mesh, 0, out);
        expect(out).toEqual({ x: 1, y: 1, z: 1 });
    });

    it("honors morphTargets.count, ignoring targets beyond it", () => {
        const mesh = makeMesh({
            _cpuPositions: new Float32Array([0, 0, 0]),
            morphTargets: makeMorph(
                [
                    [1, 0, 0],
                    [0, 1, 0],
                ],
                [1, 1],
                1 // only the first target counts
            ),
        });
        const out: Vec3 = { x: 0, y: 0, z: 0 };

        computeDeformedPositionToRef(mesh, 0, out);
        expect(out).toEqual({ x: 1, y: 0, z: 0 });
    });

    it("applies single-bone skinning", () => {
        const mesh = makeMesh({
            _cpuPositions: new Float32Array([1, 0, 0]),
            skeleton: makeSkeleton({
                boneMatrices: translationMat(0, 5, 0),
                joints: [0, 0, 0, 0],
                weights: [1, 0, 0, 0],
            }),
        });
        const out: Vec3 = { x: 0, y: 0, z: 0 };

        computeDeformedPositionToRef(mesh, 0, out);
        expect(out.x).toBeCloseTo(1);
        expect(out.y).toBeCloseTo(5);
        expect(out.z).toBeCloseTo(0);
    });

    it("blends multiple bone influences by weight", () => {
        const mesh = makeMesh({
            _cpuPositions: new Float32Array([1, 0, 0]),
            skeleton: makeSkeleton({
                // bone0 = identity, bone1 = translate +4 in x
                boneMatrices: concatMat(translationMat(0, 0, 0), translationMat(4, 0, 0)),
                joints: [0, 1, 0, 0],
                weights: [0.5, 0.5, 0, 0],
            }),
        });
        const out: Vec3 = { x: 0, y: 0, z: 0 };

        computeDeformedPositionToRef(mesh, 0, out);
        expect(out.x).toBeCloseTo(3); // 0.5 * 1 + 0.5 * (1 + 4)
        expect(out.y).toBeCloseTo(0);
        expect(out.z).toBeCloseTo(0);
    });

    it("accumulates secondary (8-bone) joints/weights", () => {
        const mesh = makeMesh({
            _cpuPositions: new Float32Array([2, 0, 0]),
            skeleton: makeSkeleton({
                // bone0 = identity, bone1 = translate +10 in y
                boneMatrices: concatMat(translationMat(0, 0, 0), translationMat(0, 10, 0)),
                joints: [0, 0, 0, 0],
                weights: [0.5, 0, 0, 0],
                joints1: [1, 0, 0, 0],
                weights1: [0.5, 0, 0, 0],
            }),
        });
        const out: Vec3 = { x: 0, y: 0, z: 0 };

        computeDeformedPositionToRef(mesh, 0, out);
        expect(out.x).toBeCloseTo(2); // 0.5 * 2 + 0.5 * 2
        expect(out.y).toBeCloseTo(5); // 0.5 * 0 + 0.5 * (0 + 10)
        expect(out.z).toBeCloseTo(0);
    });

    it("applies morph targets before skinning when both are present", () => {
        const mesh = makeMesh({
            _cpuPositions: new Float32Array([0, 0, 0]),
            morphTargets: makeMorph([[2, 0, 0]], [1]), // (0,0,0) -> (2,0,0)
            skeleton: makeSkeleton({
                boneMatrices: translationMat(0, 0, 3), // then +3 in z
                joints: [0, 0, 0, 0],
                weights: [1, 0, 0, 0],
            }),
        });
        const out: Vec3 = { x: 0, y: 0, z: 0 };

        computeDeformedPositionToRef(mesh, 0, out);
        expect(out.x).toBeCloseTo(2);
        expect(out.y).toBeCloseTo(0);
        expect(out.z).toBeCloseTo(3);
    });
});
