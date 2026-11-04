import { describe, expect, it } from "vitest";

import type { MorphTargetData } from "../../../packages/babylon-lite/src/animation/types";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { PickingInfo } from "../../../packages/babylon-lite/src/picking/picking-info";
import { captureDeformPose, deformTriangleToRef } from "../../../packages/babylon-lite/src/picking/deformed-vertex";
import { populateDetailedMeshInfo } from "../../../packages/babylon-lite/src/picking/detailed-picking";

// One triangle in the z=0 plane: v0 (0,0,0), v1 (1,0,0), v2 (0,1,0). With this rest triangle the
// barycentric solve reduces to bv = localPoint.x and bu = 1 - x - y, so the expected values below are
// readable by inspection.
const REST_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const REST_NORMALS = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
const INDICES = new Uint32Array([0, 1, 2]);
const LOCAL_POINT: readonly [number, number, number] = [0.25, 0.5, 0];

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as unknown as Mat4;

function makeMorph(deltas: number[], weights: number[]): MorphTargetData {
    return {
        targets: [{ positions: new Float32Array(deltas), normals: null }],
        weights: new Float32Array(weights),
        count: 1,
    } as unknown as MorphTargetData;
}

function makeMesh(morph: MorphTargetData | null): Mesh {
    return {
        _cpuPositions: REST_POSITIONS,
        _cpuIndices: INDICES,
        _cpuNormals: REST_NORMALS,
        morphTargets: morph,
    } as unknown as Mesh;
}

function makeInfo(): PickingInfo {
    return {} as unknown as PickingInfo;
}

/** Bind a mesh's live pose the way the picker does at readback time. */
function liveDeformer(): (mesh: Mesh, i0: number, i1: number, i2: number, out: Float32Array) => boolean {
    return (mesh, i0, i1, i2, out) => deformTriangleToRef(mesh, i0, i1, i2, out);
}

function populate(mesh: Mesh, deform: ReturnType<typeof liveDeformer> | null): PickingInfo {
    const info = makeInfo();
    populateDetailedMeshInfo(info, mesh, 0, LOCAL_POINT, REST_POSITIONS, REST_NORMALS, IDENTITY, true, deform);
    return info;
}

describe("populateDetailedMeshInfo barycentrics under deformation", () => {
    it("solves barycentrics in rest space for an undeformed mesh", () => {
        const info = populate(makeMesh(null), null);
        expect(info.bv).toBeCloseTo(0.25, 10);
        expect(info.bu).toBeCloseTo(0.25, 10);
    });

    it("keeps barycentrics unchanged when a morph translates the whole triangle", () => {
        // A uniform translation cannot move the hit relative to the surface, so bu/bv must not budge.
        // Solving the rest-space localPoint against the translated vertices would shift p by -T and
        // produce wildly wrong weights (bv would land near -4.75 here), so this pins the space bug.
        const morph = makeMorph([5, 7, 9, 5, 7, 9, 5, 7, 9], [1]);
        const info = populate(makeMesh(morph), liveDeformer());

        expect(info.bv).toBeCloseTo(0.25, 10);
        expect(info.bu).toBeCloseTo(0.25, 10);
    });

    it("keeps barycentrics in rest space but rotates the face normal when a morph shears the triangle", () => {
        // Only v2 moves, from (0,1,0) to (0,1,1). Rest face normal is +z; the deformed edges are
        // (1,0,0) and (0,1,1), whose cross product is (0,-1,1).
        const morph = makeMorph([0, 0, 0, 0, 0, 0, 0, 0, 1], [1]);
        const info = populate(makeMesh(morph), liveDeformer());

        expect(info.bv).toBeCloseTo(0.25, 10);
        expect(info.bu).toBeCloseTo(0.25, 10);

        const invSqrt2 = 1 / Math.SQRT2;
        expect(info.pickedFaceNormal![0]).toBeCloseTo(0, 10);
        expect(info.pickedFaceNormal![1]).toBeCloseTo(-invSqrt2, 10);
        expect(info.pickedFaceNormal![2]).toBeCloseTo(invSqrt2, 10);
    });

    it("reports the rest face normal when the mesh does not deform", () => {
        const info = populate(makeMesh(null), null);
        expect(info.pickedFaceNormal![2]).toBeCloseTo(1, 10);
    });
});

describe("captureDeformPose", () => {
    it("resolves the triangle against the captured pose after the animation advances", () => {
        const morph = makeMorph([0, 0, 0, 0, 0, 0, 0, 0, 1], [1]);
        const mesh = makeMesh(morph);
        const pose = captureDeformPose(mesh);
        expect(pose).not.toBeNull();

        // The animation tick mutates the weight buffer in place while the GPU readback is pending.
        morph.weights[0] = 0;

        const captured = new Float32Array(9);
        expect(deformTriangleToRef(mesh, 0, 1, 2, captured, pose)).toBe(true);
        expect(captured[8]).toBeCloseTo(1, 10);

        const live = new Float32Array(9);
        expect(deformTriangleToRef(mesh, 0, 1, 2, live)).toBe(true);
        expect(live[8]).toBeCloseTo(0, 10);
    });

    it("returns null for a mesh with no skeleton or morph targets", () => {
        expect(captureDeformPose(makeMesh(null))).toBeNull();
    });
});
