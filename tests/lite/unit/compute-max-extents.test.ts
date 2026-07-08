import { describe, expect, it } from "vitest";

import type { AnimationGroup } from "../../../packages/babylon-lite/src/animation/animation-group";
import type { MorphTargetData, SkeletonData } from "../../../packages/babylon-lite/src/animation/types";
import { computeMaxExtents } from "../../../packages/babylon-lite/src/mesh/compute-max-extents";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";

// ── Column-major mat4 fixtures ──

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

function scaleMat(x: number, y: number, z: number): Float32Array {
    const m = identityMat();
    m[0] = x;
    m[5] = y;
    m[10] = z;
    return m;
}

/** Concatenate per-bone 4x4 matrices into a single boneMatrices buffer. */
function concatMat(...mats: Float32Array[]): Float32Array {
    const out = new Float32Array(mats.length * 16);
    mats.forEach((m, i) => out.set(m, i * 16));
    return out;
}

function makeMorph(targets: number[][]): MorphTargetData {
    // computeMaxExtents bounds each target independently (base + delta) and never reads weights,
    // so the weights here are intentionally zero to prove weight-independence.
    return {
        targets: targets.map((positions) => ({ positions: new Float32Array(positions), normals: null })),
        weights: new Float32Array(targets.length),
        count: targets.length,
    } as unknown as MorphTargetData;
}

function makeSkeleton(o: { boneCount: number; boneMatrices: Float32Array; joints: number[]; weights: number[] }): SkeletonData {
    return {
        boneCount: o.boneCount,
        boneMatrices: o.boneMatrices,
        joints: new Uint16Array(o.joints),
        weights: new Float32Array(o.weights),
        joints1: null,
        weights1: null,
    } as unknown as SkeletonData;
}

function makeMesh(fields: Partial<Omit<Mesh, "worldMatrix">> & { worldMatrix: Float32Array }): Mesh {
    return fields as unknown as Mesh;
}

describe("computeMaxExtents", () => {
    it("bounds a static non-skinned mesh by its world matrix (translation)", () => {
        const mesh = makeMesh({
            _cpuPositions: new Float32Array([-1, -1, -1, 1, 1, 1]),
            worldMatrix: translationMat(10, 0, 0),
        });

        const extent = computeMaxExtents([mesh])[0]!;

        expect(extent.minimum[0]).toBeCloseTo(9);
        expect(extent.maximum[0]).toBeCloseTo(11);
        expect(extent.minimum[1]).toBeCloseTo(-1);
        expect(extent.maximum[1]).toBeCloseTo(1);
        expect(extent.minimum[2]).toBeCloseTo(-1);
        expect(extent.maximum[2]).toBeCloseTo(1);
    });

    it("applies world-matrix scale", () => {
        const mesh = makeMesh({
            _cpuPositions: new Float32Array([-1, -2, -3, 1, 2, 3]),
            worldMatrix: scaleMat(2, 3, 4),
        });

        const extent = computeMaxExtents([mesh])[0]!;

        expect(extent.minimum[0]).toBeCloseTo(-2);
        expect(extent.maximum[0]).toBeCloseTo(2);
        expect(extent.minimum[1]).toBeCloseTo(-6);
        expect(extent.maximum[1]).toBeCloseTo(6);
        expect(extent.minimum[2]).toBeCloseTo(-12);
        expect(extent.maximum[2]).toBeCloseTo(12);
    });

    it("expands the box by morph-target deltas (weight-independent)", () => {
        const mesh = makeMesh({
            _cpuPositions: new Float32Array([0, 0, 0]),
            worldMatrix: identityMat(),
            morphTargets: makeMorph([[5, -2, 0]]),
        });

        const extent = computeMaxExtents([mesh])[0]!;

        // Base (0,0,0) expanded by delta (5,-2,0): min (0,-2,0), max (5,0,0).
        expect(extent.minimum[0]).toBeCloseTo(0);
        expect(extent.maximum[0]).toBeCloseTo(5);
        expect(extent.minimum[1]).toBeCloseTo(-2);
        expect(extent.maximum[1]).toBeCloseTo(0);
        expect(extent.minimum[2]).toBeCloseTo(0);
        expect(extent.maximum[2]).toBeCloseTo(0);
    });

    it("bounds each morph target independently against the base (matches core, does not sum stacking)", () => {
        const mesh = makeMesh({
            _cpuPositions: new Float32Array([0, 0, 0]),
            worldMatrix: identityMat(),
            // Two targets whose x-deltas would stack to +3 if summed, plus one negative y-delta.
            morphTargets: makeMorph([
                [1, 0, 0],
                [2, -1, 0],
            ]),
        });

        const extent = computeMaxExtents([mesh])[0]!;

        // Core takes the per-vertex AABB of {base, base+d0, base+d1}, so max x = max(0, 1, 2) = 2 (NOT
        // the summed 3). ViewerLite must match core so the full and lite viewers frame identically.
        expect(extent.minimum[0]).toBeCloseTo(0);
        expect(extent.maximum[0]).toBeCloseTo(2);
        expect(extent.minimum[1]).toBeCloseTo(-1);
        expect(extent.maximum[1]).toBeCloseTo(0);
        expect(extent.minimum[2]).toBeCloseTo(0);
        expect(extent.maximum[2]).toBeCloseTo(0);
    });

    it("bounds a skinned mesh per-bone using worldMatrix x boneMatrix", () => {
        const mesh = makeMesh({
            _cpuPositions: new Float32Array([-1, 0, 0, 1, 2, 3]),
            worldMatrix: identityMat(),
            skeleton: makeSkeleton({
                boneCount: 1,
                boneMatrices: translationMat(10, 0, 0),
                joints: [0, 0, 0, 0, 0, 0, 0, 0],
                weights: [1, 0, 0, 0, 1, 0, 0, 0],
            }),
        });

        const extent = computeMaxExtents([mesh])[0]!;

        // bone0 box min (-1,0,0) max (1,2,3), translated +10 in x.
        expect(extent.minimum[0]).toBeCloseTo(9);
        expect(extent.maximum[0]).toBeCloseTo(11);
        expect(extent.minimum[1]).toBeCloseTo(0);
        expect(extent.maximum[1]).toBeCloseTo(2);
        expect(extent.minimum[2]).toBeCloseTo(0);
        expect(extent.maximum[2]).toBeCloseTo(3);
    });

    it("unions the boxes of multiple bones", () => {
        const mesh = makeMesh({
            _cpuPositions: new Float32Array([1, 0, 0, 0, 1, 0]),
            worldMatrix: identityMat(),
            skeleton: makeSkeleton({
                boneCount: 2,
                // bone0 identity, bone1 translate +20 in y
                boneMatrices: concatMat(translationMat(0, 0, 0), translationMat(0, 20, 0)),
                joints: [0, 0, 0, 0, 1, 0, 0, 0],
                weights: [1, 0, 0, 0, 1, 0, 0, 0],
            }),
        });

        const extent = computeMaxExtents([mesh])[0]!;

        // vertex0 -> bone0: (1,0,0); vertex1 -> bone1: (0,21,0). Union: min (0,0,0) max (1,21,0).
        expect(extent.minimum[0]).toBeCloseTo(0);
        expect(extent.maximum[0]).toBeCloseTo(1);
        expect(extent.minimum[1]).toBeCloseTo(0);
        expect(extent.maximum[1]).toBeCloseTo(21);
        expect(extent.minimum[2]).toBeCloseTo(0);
        expect(extent.maximum[2]).toBeCloseTo(0);
    });

    it("falls back to boundMin/boundMax when there is no CPU geometry", () => {
        const mesh = makeMesh({
            worldMatrix: translationMat(0, 5, 0),
            boundMin: [-1, -1, -1],
            boundMax: [1, 1, 1],
        });

        const extent = computeMaxExtents([mesh])[0]!;

        expect(extent.minimum[0]).toBeCloseTo(-1);
        expect(extent.maximum[0]).toBeCloseTo(1);
        expect(extent.minimum[1]).toBeCloseTo(4);
        expect(extent.maximum[1]).toBeCloseTo(6);
        expect(extent.minimum[2]).toBeCloseTo(-1);
        expect(extent.maximum[2]).toBeCloseTo(1);
    });

    it("returns an inverted extent for a mesh with no geometry or bounds", () => {
        const mesh = makeMesh({ worldMatrix: identityMat() });

        const extent = computeMaxExtents([mesh])[0]!;

        expect(extent.minimum[0]).toBe(Number.POSITIVE_INFINITY);
        expect(extent.maximum[0]).toBe(Number.NEGATIVE_INFINITY);
    });

    it("returns one extent per input mesh, in order", () => {
        const a = makeMesh({ _cpuPositions: new Float32Array([0, 0, 0, 1, 1, 1]), worldMatrix: identityMat() });
        const b = makeMesh({ _cpuPositions: new Float32Array([0, 0, 0, 2, 2, 2]), worldMatrix: translationMat(100, 0, 0) });

        const extents = computeMaxExtents([a, b]);

        expect(extents).toHaveLength(2);
        expect(extents[0]!.maximum[0]).toBeCloseTo(1);
        expect(extents[1]!.minimum[0]).toBeCloseTo(100);
        expect(extents[1]!.maximum[0]).toBeCloseTo(102);
    });

    it("sweeps the animation to capture the full swept volume and restores playback state", () => {
        const worldMatrix = identityMat();
        const mesh = makeMesh({ _cpuPositions: new Float32Array([-1, -1, -1, 1, 1, 1]), worldMatrix });

        // Minimal controller stand-in: goToFrame() syncs ctrl.time to the target frame's time and
        // then calls tick(), which we use to slide the mesh's world matrix along x by the elapsed
        // seconds. This makes the sampled pose change across the sweep without a real GPU/scene.
        const ctrl = {
            time: 0,
            playing: false,
            speedRatio: 1,
            loop: true,
            tick() {
                worldMatrix[12] = ctrl.time;
            },
            _setMask() {},
        };
        const group = {
            name: "move-x",
            duration: 1,
            frameRate: 60,
            isPlaying: true,
            currentTime: 0.5,
            speedRatio: 1,
            loopAnimation: true,
            weight: 1,
            targetedAnimations: [],
            _stopped: false,
            _ctrl: ctrl,
        } as unknown as AnimationGroup;

        const extent = computeMaxExtents([mesh], group, null, 0.25)[0]!;

        // x-translation sweeps 0..1, so the box x-range [-1,1] sweeps to the union [-1, 2].
        expect(extent.minimum[0]).toBeCloseTo(-1);
        expect(extent.maximum[0]).toBeCloseTo(2);
        expect(extent.minimum[1]).toBeCloseTo(-1);
        expect(extent.maximum[1]).toBeCloseTo(1);

        // Original playback position and state are restored.
        expect(group.currentTime).toBeCloseTo(0.5);
        expect(group.isPlaying).toBe(true);
    });
});
