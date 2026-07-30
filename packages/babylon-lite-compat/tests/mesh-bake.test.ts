import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("babylon-lite", async (importOriginal) => {
    const actual = await importOriginal<typeof import("babylon-lite")>();
    return { ...actual, resizeMeshGeometry: vi.fn() };
});

import { resizeMeshGeometry } from "babylon-lite";
import { Mesh } from "../src/meshes/meshes";
import { Matrix } from "../src/math/matrix";

/**
 * GPU-free forwarding tests for the shared transform-bake helper (`_bakeMatrix`)
 * and its two public entry points, `bakeCurrentTransformIntoVertices` (resets the
 * node transform) and `bakeTransformIntoVertices(matrix)` (does not). The bake only
 * transforms the retained CPU buffers and forwards them to Lite's
 * `resizeMeshGeometry`, so it can be exercised against a fake `_lite` with the Lite
 * upload mocked. (Issue #475.)
 */

const mockedResize = vi.mocked(resizeMeshGeometry);

function makeMesh(overrides?: { normals?: Float32Array; uvs?: Float32Array; uv2?: Float32Array; tangents?: Float32Array; colors?: Float32Array }): Mesh {
    const mesh = Object.create(Mesh.prototype) as Mesh;
    const lite = {
        _cpuPositions: new Float32Array([1, 1, 1]),
        _cpuNormals: overrides?.normals,
        _cpuIndices: new Uint32Array([0, 1, 2]),
        _cpuUvs: overrides?.uvs,
        _cpuUv2s: overrides?.uv2,
        _cpuTangents: overrides?.tangents,
        _cpuColors: overrides?.colors,
    };
    (mesh as unknown as { _lite: unknown })._lite = lite;
    (mesh as unknown as { _scene: unknown })._scene = { getEngine: () => ({ _lite: {} }) };
    (mesh as unknown as { _lastUv2?: Float32Array })._lastUv2 = overrides?.uv2;
    (mesh as unknown as { _lastTangents?: Float32Array })._lastTangents = overrides?.tangents;
    (mesh as unknown as { _lastColors?: Float32Array })._lastColors = overrides?.colors;
    return mesh;
}

describe("Mesh transform bake (issue #475)", () => {
    beforeEach(() => mockedResize.mockClear());

    it("transforms positions by the full matrix", () => {
        const mesh = makeMesh();
        (mesh as unknown as { _bakeMatrix(m: Matrix): boolean })._bakeMatrix(Matrix.Scaling(2, 3, 4));
        const positions = mockedResize.mock.calls[0]![2];
        expect(Array.from(positions)).toEqual([2, 3, 4]);
    });

    it("transforms normals by the inverse-transpose (correct under non-uniform scale)", () => {
        // Under scale (2,1,1) a raw 3×3 multiply would tilt the normal toward X;
        // the inverse-transpose (0.5,1,1) tilts it toward Y — the correct result.
        const mesh = makeMesh({ normals: new Float32Array([1, 1, 0]) });
        (mesh as unknown as { _bakeMatrix(m: Matrix): boolean })._bakeMatrix(Matrix.Scaling(2, 1, 1));
        const normals = mockedResize.mock.calls[0]![3];
        const invSqrt5 = 1 / Math.sqrt(1.25); // (0.5,1,0) normalized
        expect(normals[0]).toBeCloseTo(0.5 * invSqrt5, 6);
        expect(normals[1]).toBeCloseTo(1 * invSqrt5, 6);
        expect(normals[2]).toBeCloseTo(0, 6);
        // sanity: it is NOT the raw-3×3 result (which would favour X)
        expect(normals[0]).toBeLessThan(normals[1]!);
    });

    it("forwards uv / uv2 / tangent / color so they are not lost on the reupload", () => {
        const uvs = new Float32Array([0.1, 0.2]);
        const uv2 = new Float32Array([0.3, 0.4]);
        const tangents = new Float32Array([1, 0, 0, 1]);
        const colors = new Float32Array([1, 1, 1, 1]);
        const mesh = makeMesh({ normals: new Float32Array([0, 0, 1]), uvs, uv2, tangents, colors });
        (mesh as unknown as { _bakeMatrix(m: Matrix): boolean })._bakeMatrix(Matrix.Identity());
        const call = mockedResize.mock.calls[0]!;
        expect(call[5]).toBe(uvs);
        expect(call[6]).toBe(uv2);
        expect(call[7]).toEqual(tangents);
        expect(call[8]).toBe(colors);
    });

    it("preserves auxiliary attributes retained directly by the Lite mesh", () => {
        const uv2 = new Float32Array([0.3, 0.4]);
        const tangents = new Float32Array([1, 0, 0, 1]);
        const colors = new Float32Array([1, 1, 1, 1]);
        const mesh = makeMesh({ normals: new Float32Array([0, 0, 1]), uv2, tangents, colors });
        Object.assign(mesh as unknown as Record<string, unknown>, { _lastUv2: undefined, _lastTangents: undefined, _lastColors: undefined });

        (mesh as unknown as { _bakeMatrix(m: Matrix): boolean })._bakeMatrix(Matrix.Identity());

        const call = mockedResize.mock.calls[0]!;
        expect(call[6]).toBe(uv2);
        expect(call[7]).toEqual(tangents);
        expect(call[8]).toBe(colors);
    });

    it("transforms tangent directions while preserving handedness", () => {
        const mesh = makeMesh({ normals: new Float32Array([0, 0, 1]), tangents: new Float32Array([1, 1, 0, -1]) });

        (mesh as unknown as { _bakeMatrix(m: Matrix): boolean })._bakeMatrix(Matrix.Scaling(2, 1, 1));

        const tangent = mockedResize.mock.calls[0]![7]!;
        expect(tangent[0]).toBeCloseTo(2 / Math.sqrt(5), 6);
        expect(tangent[1]).toBeCloseTo(1 / Math.sqrt(5), 6);
        expect(tangent[2]).toBeCloseTo(0, 6);
        expect(tangent[3]).toBe(-1);
    });

    it("reverses triangle winding for a negative-determinant bake", () => {
        const mesh = makeMesh({ normals: new Float32Array([0, 0, 1]) });

        (mesh as unknown as { _bakeMatrix(m: Matrix): boolean })._bakeMatrix(Matrix.Scaling(-1, 1, 1));

        expect(Array.from(mockedResize.mock.calls[0]![4])).toEqual([0, 2, 1]);
    });

    it("is a no-op when there is no CPU geometry", () => {
        const mesh = Object.create(Mesh.prototype) as Mesh;
        (mesh as unknown as { _lite: unknown })._lite = {};
        (mesh as unknown as { _scene: unknown })._scene = { getEngine: () => ({ _lite: {} }) };
        const ok = (mesh as unknown as { _bakeMatrix(m: Matrix): boolean })._bakeMatrix(Matrix.Identity());
        expect(ok).toBe(false);
        expect(mockedResize).not.toHaveBeenCalled();
    });

    it("bakeCurrentTransformIntoVertices bakes the node transform and resets it to identity", () => {
        const mesh = makeMesh();
        const vec = (x: number, y: number, z: number) => ({
            x,
            y,
            z,
            set(a: number, b: number, c: number) {
                this.x = a;
                this.y = b;
                this.z = c;
            },
        });
        const node = { position: vec(5, 0, 0), rotation: vec(0, 0, 0), scaling: vec(2, 2, 2), rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 } };
        (mesh as unknown as { _node: unknown })._node = node;
        const bakeSpy = vi.fn((_m: Matrix) => true);
        (mesh as unknown as { _bakeMatrix: unknown })._bakeMatrix = bakeSpy;

        mesh.bakeCurrentTransformIntoVertices();

        // The composed node TRS was handed to the shared helper…
        const composed = Matrix.Compose({ x: 2, y: 2, z: 2 } as never, { x: 0, y: 0, z: 0, w: 1 }, { x: 5, y: 0, z: 0 } as never);
        expect(Array.from(bakeSpy.mock.calls[0]![0].m)).toEqual(Array.from(composed.m));
        // …and the node transform is reset to identity.
        expect([node.position.x, node.position.y, node.position.z]).toEqual([0, 0, 0]);
        expect([node.rotation.x, node.rotation.y, node.rotation.z]).toEqual([0, 0, 0]);
        expect([node.scaling.x, node.scaling.y, node.scaling.z]).toEqual([1, 1, 1]);
    });

    it("bakeTransformIntoVertices bakes an arbitrary matrix WITHOUT resetting the node transform", () => {
        const mesh = makeMesh();
        const node = { position: { x: 5, y: 6, z: 7 }, rotation: { x: 0, y: 0, z: 0 }, scaling: { x: 2, y: 2, z: 2 } };
        (mesh as unknown as { _node: unknown })._node = node;
        const bakeSpy = vi.fn((_m: Matrix) => true);
        (mesh as unknown as { _bakeMatrix: unknown })._bakeMatrix = bakeSpy;

        const arbitrary = Matrix.Translation(9, 9, 9);
        mesh.bakeTransformIntoVertices(arbitrary);

        expect(bakeSpy).toHaveBeenCalledWith(arbitrary);
        // node transform is untouched (unlike the current-transform variant)
        expect([node.position.x, node.position.y, node.position.z]).toEqual([5, 6, 7]);
        expect([node.scaling.x, node.scaling.y, node.scaling.z]).toEqual([2, 2, 2]);
    });
});
