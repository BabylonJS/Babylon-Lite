import { describe, expect, it, vi } from "vitest";

import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { getPickedNormal, getPickedUV } from "../../../packages/babylon-lite/src/picking/picking-helpers";
import { pickMeshesWithRayPrecise, type TrianglePickingPredicate } from "../../../packages/babylon-lite/src/picking/precise-ray-pick";
import type { Ray } from "../../../packages/babylon-lite/src/picking/ray";

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as unknown as Mat4;
const RAY: Ray = { origin: [0, 0, -2], direction: [0, 0, 1], length: 100 };

function translation(x: number, y: number, z: number): Mat4 {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]) as unknown as Mat4;
}

function scaling(x: number, y: number, z: number): Mat4 {
    return new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]) as unknown as Mat4;
}

function mesh(positions: number[], indices: number[], worldMatrix: Mat4 = IDENTITY): Mesh {
    const xs = positions.filter((_, index) => index % 3 === 0);
    const ys = positions.filter((_, index) => index % 3 === 1);
    const zs = positions.filter((_, index) => index % 3 === 2);
    return {
        pickable: true,
        worldMatrix,
        boundMin: [Math.min(...xs), Math.min(...ys), Math.min(...zs)],
        boundMax: [Math.max(...xs), Math.max(...ys), Math.max(...zs)],
        _cpuPositions: new Float32Array(positions),
        _cpuIndices: new Uint32Array(indices),
        _cpuNormals: new Float32Array(Array.from({ length: positions.length / 3 }, () => [0, 0, -1]).flat()),
        _cpuUvs: new Float32Array(Array.from({ length: positions.length / 3 }, (_, index) => [index === 1 ? 1 : 0, index === 2 ? 1 : 0]).flat()),
    } as unknown as Mesh;
}

describe("pickMeshesWithRayPrecise", () => {
    it("rejects an AABB hit through empty triangle space", () => {
        const triangle = mesh([-1, -1, 0, 1, -1, 0, -1, 1, 0], [0, 1, 2]);
        const ray: Ray = { origin: [0.9, 0.9, -2], direction: [0, 0, 1], length: 100 };

        expect(pickMeshesWithRayPrecise([triangle], ray).hit).toBe(false);
    });

    it("uses Babylon.js's edge tolerance for barycentric tests", () => {
        const triangle = mesh([-1, -1, 0, 1, -1, 0, -1, 1, 0], [0, 1, 2]);
        const ray: Ray = { origin: [0.0005, 0.0005, -2], direction: [0, 0, 1], length: 100 };

        expect(pickMeshesWithRayPrecise([triangle], ray).hit).toBe(true);
    });

    it("returns the nearest triangle unless fastCheck requests the first hit", () => {
        const triangles = mesh([-1, -1, 2, 1, -1, 2, 0, 1, 2, -1, -1, 0, 1, -1, 0, 0, 1, 0], [0, 1, 2, 3, 4, 5]);

        expect(pickMeshesWithRayPrecise([triangles], RAY).distance).toBe(2);
        expect(pickMeshesWithRayPrecise([triangles], RAY, { fastCheck: true }).distance).toBe(4);
    });

    it("filters triangles and fills face, barycentric, normal, and UV detail", () => {
        const triangle = mesh([-1, -1, 0, 1, -1, 0, -1, 1, 0], [0, 1, 2]);
        const predicate = vi.fn<TrianglePickingPredicate>(() => true);
        const hit = pickMeshesWithRayPrecise([triangle], { origin: [-0.5, -0.5, -2], direction: [0, 0, 1], length: 100 }, { trianglePredicate: predicate });

        expect(predicate).toHaveBeenCalledWith([-1, -1, 0], [1, -1, 0], [-1, 1, 0], expect.objectContaining({ origin: [-0.5, -0.5, -2] }), 0, 1, 2);
        expect(hit.faceId).toBe(0);
        expect(hit.bu).toBeCloseTo(0.5);
        expect(hit.bv).toBeCloseTo(0.25);
        expect(getPickedNormal(hit)).toEqual([0, 0, -1]);
        expect(getPickedUV(hit)).toEqual([0.25, 0.25]);
        expect(pickMeshesWithRayPrecise([triangle], RAY, { trianglePredicate: () => false }).hit).toBe(false);
    });

    it("uses transformed geometry and iterates thin instances with their indices", () => {
        const triangle = mesh([-1, -1, 0, 1, -1, 0, 0, 1, 0], [0, 1, 2], translation(0, 0, 3));
        const matrices = new Float32Array(32);
        matrices.set(translation(5, 0, 0), 0);
        matrices.set(translation(0, 0, 2), 16);
        triangle.thinInstances = {
            matrices,
            count: 2,
        } as NonNullable<Mesh["thinInstances"]>;
        const predicate = vi.fn((_mesh: Mesh, index: number) => index === -1 || index === 1);
        const hit = pickMeshesWithRayPrecise([triangle], RAY, { predicate });

        expect(predicate.mock.calls.map((call) => call[1])).toEqual([-1, 0, 1]);
        expect(hit.hit).toBe(true);
        expect(hit.distance).toBe(7);
        expect(hit.pickedPoint).toEqual([0, 0, 5]);
        expect(hit.thinInstanceIndex).toBe(1);
    });

    it("does not pick a thin-instance prototype when the active count is zero", () => {
        const triangle = mesh([-1, -1, 0, 1, -1, 0, 0, 1, 0], [0, 1, 2]);
        triangle.thinInstances = {
            matrices: new Float32Array(IDENTITY),
            count: 0,
        } as NonNullable<Mesh["thinInstances"]>;

        expect(pickMeshesWithRayPrecise([triangle], RAY).hit).toBe(false);
    });

    it("normalizes and rescales the local predicate ray", () => {
        const triangle = mesh([-1, -1, 0, 1, -1, 0, 0, 1, 0], [0, 1, 2], scaling(2, 1, 0.5));
        const predicate = vi.fn<TrianglePickingPredicate>(() => true);

        expect(pickMeshesWithRayPrecise([triangle], RAY, { trianglePredicate: predicate }).hit).toBe(true);
        const localRay = predicate.mock.calls[0]![3] as Ray;
        expect(localRay.direction).toEqual([0, 0, 1]);
        expect(localRay.length).toBe(200);
    });

    it("uses inverse-transpose world normals under non-uniform scaling", () => {
        const triangle = mesh([0, 0, 0, 1, 0, 1, 0, 1, 0], [0, 1, 2], scaling(2, 1, 1));
        triangle._cpuNormals = new Float32Array([-1, 0, 1, -1, 0, 1, -1, 0, 1]);
        const hit = pickMeshesWithRayPrecise([triangle], { origin: [0.5, 0.25, -2], direction: [0, 0, 1], length: 100 });
        const normal = getPickedNormal(hit, true)!;

        expect(normal[0]).toBeCloseTo(1 / Math.sqrt(5));
        expect(normal[1]).toBeCloseTo(0);
        expect(normal[2]).toBeCloseTo(-2 / Math.sqrt(5));
    });

    it("uses the composed inverse-transpose for non-uniformly scaled thin-instance normals", () => {
        const triangle = mesh([0, 0, 0, 1, 0, 1, 0, 1, 0], [0, 1, 2]);
        triangle._cpuNormals = new Float32Array([-1, 0, 1, -1, 0, 1, -1, 0, 1]);
        triangle.thinInstances = {
            matrices: new Float32Array(scaling(2, 1, 1)),
            count: 1,
        } as NonNullable<Mesh["thinInstances"]>;
        const hit = pickMeshesWithRayPrecise([triangle], { origin: [0.5, 0.25, -2], direction: [0, 0, 1], length: 100 });
        const normal = getPickedNormal(hit, true)!;

        expect(normal[0]).toBeCloseTo(1 / Math.sqrt(5));
        expect(normal[1]).toBeCloseTo(0);
        expect(normal[2]).toBeCloseTo(-2 / Math.sqrt(5));
    });

    it("skips actively deformed meshes rather than returning rest-pose hits", () => {
        const triangle = mesh([-1, -1, 0, 1, -1, 0, 0, 1, 0], [0, 1, 2]);
        triangle.morphTargets = {} as NonNullable<Mesh["morphTargets"]>;

        expect(pickMeshesWithRayPrecise([triangle], RAY).hit).toBe(false);
    });

    it("honors pickability and cleanly misses singular or absent geometry", () => {
        const triangle = mesh([-1, -1, 0, 1, -1, 0, 0, 1, 0], [0, 1, 2]);
        triangle.pickable = false;
        const singular = mesh([-1, -1, 0, 1, -1, 0, 0, 1, 0], [0, 1, 2], new Float32Array(16) as unknown as Mat4);
        const absentGeometry = { pickable: true, worldMatrix: IDENTITY } as Mesh;

        expect(pickMeshesWithRayPrecise([triangle], RAY).hit).toBe(false);
        expect(pickMeshesWithRayPrecise([triangle], RAY, { skipPickableCheck: true }).hit).toBe(true);
        expect(pickMeshesWithRayPrecise([singular, absentGeometry], RAY).hit).toBe(false);
    });
});
