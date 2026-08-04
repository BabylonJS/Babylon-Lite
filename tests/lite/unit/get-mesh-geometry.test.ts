import { describe, expect, it, vi } from "vitest";

import { getMeshGeometry } from "../../../packages/babylon-lite/src/mesh/get-mesh-geometry";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";

function completeMesh(): Mesh {
    return {
        _cpuPositions: new Float32Array([0, 1, 2, 3, 4, 5]),
        _cpuNormals: new Float32Array([0, 0, 1, 0, 1, 0]),
        _cpuIndices: new Uint32Array([0, 1, 0]),
        _cpuUvs: new Float32Array([0, 0, 1, 1]),
        _cpuUv2s: new Float32Array([0.25, 0.5, 0.75, 1]),
        _cpuTangents: new Float32Array([1, 0, 0, 1, 0, 1, 0, -1]),
        _cpuColors: new Float32Array([1, 0, 0, 1, 0, 1, 0, 0.5]),
    } as unknown as Mesh;
}

describe("getMeshGeometry", () => {
    it("returns exact caller-owned copies of every retained attribute", () => {
        const mesh = completeMesh();
        const geometry = getMeshGeometry(mesh);

        expect(geometry).toEqual({
            positions: mesh._cpuPositions,
            normals: mesh._cpuNormals,
            indices: mesh._cpuIndices,
            uvs: mesh._cpuUvs,
            uvs2: mesh._cpuUv2s,
            tangents: mesh._cpuTangents,
            colors: mesh._cpuColors,
        });
        expect(geometry).not.toBeNull();
        expect(geometry!.positions).not.toBe(mesh._cpuPositions);
        expect(geometry!.normals).not.toBe(mesh._cpuNormals);
        expect(geometry!.indices).not.toBe(mesh._cpuIndices);
        expect(geometry!.uvs).not.toBe(mesh._cpuUvs);
        expect(geometry!.uvs2).not.toBe(mesh._cpuUv2s);
        expect(geometry!.tangents).not.toBe(mesh._cpuTangents);
        expect(geometry!.colors).not.toBe(mesh._cpuColors);

        geometry!.positions[0] = 99;
        geometry!.uvs![0] = 0.75;
        expect(mesh._cpuPositions![0]).toBe(0);
        expect(mesh._cpuUvs![0]).toBe(0);
    });

    it("allows UV access through the public result and omits unavailable optional attributes", () => {
        const mesh = completeMesh();
        mesh._cpuUv2s = null;
        mesh._cpuTangents = null;
        mesh._cpuColors = null;

        const geometry = getMeshGeometry(mesh);
        const uvs = geometry?.uvs;

        expect(Array.from(uvs ?? [])).toEqual([0, 0, 1, 1]);
        expect(geometry?.uvs2).toBeUndefined();
        expect(geometry?.tangents).toBeUndefined();
        expect(geometry?.colors).toBeUndefined();
        expect(Object.hasOwn(geometry!, "uvs2")).toBe(false);
        expect(Object.hasOwn(geometry!, "tangents")).toBe(false);
        expect(Object.hasOwn(geometry!, "colors")).toBe(false);
    });

    it.each(["_cpuPositions", "_cpuNormals", "_cpuIndices"] as const)("returns null when required geometry %s is unavailable", (field) => {
        const mesh = completeMesh();
        mesh[field] = undefined;

        expect(getMeshGeometry(mesh)).toBeNull();
    });

    it("materializes lazy CPU accessors once and still returns independent copies", () => {
        const positions = new Float32Array([0, 1, 2]);
        const normals = new Float32Array([0, 0, 1]);
        const indices = new Uint32Array([0]);
        const readPositions = vi.fn(() => positions);
        const readNormals = vi.fn(() => normals);
        const mesh = { _cpuIndices: indices } as unknown as Mesh;
        Object.defineProperties(mesh, {
            _cpuPositions: { get: readPositions },
            _cpuNormals: { get: readNormals },
        });

        const geometry = getMeshGeometry(mesh);

        expect(readPositions).toHaveBeenCalledTimes(1);
        expect(readNormals).toHaveBeenCalledTimes(1);
        expect(geometry?.positions).toEqual(positions);
        expect(geometry?.positions).not.toBe(positions);
        expect(geometry?.normals).not.toBe(normals);
        expect(geometry?.indices).not.toBe(indices);
    });
});
