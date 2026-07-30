import { describe, expect, it, vi } from "vitest";

/**
 * `AbstractMesh.getIndices()` / `setIndices()` (issue #472) are thin wrappers over
 * Babylon Lite's retained CPU geometry: `getIndices` reads back `_cpuIndices`, and
 * `setIndices` re-uploads the geometry in place via `resizeMeshGeometry`, swapping
 * only the index buffer. The real upload needs a GPU device, so these tests mock
 * `resizeMeshGeometry` and exercise the pure forwarding surface GPU-free.
 */
vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        resizeMeshGeometry: vi.fn(),
    };
});

import { resizeMeshGeometry } from "babylon-lite";
import { AbstractMesh, Mesh, VertexBuffer } from "../src/meshes/meshes";

const resizeMeshGeometryMock = vi.mocked(resizeMeshGeometry);

/** Build an AbstractMesh with a minimal fake `_lite` + scene/engine handle. */
function fakeMesh(lite: Record<string, unknown>, withEngine = true): AbstractMesh {
    const mesh = Object.create(AbstractMesh.prototype) as AbstractMesh;
    (mesh as unknown as { _lite: unknown })._lite = lite;
    const engine = { _lite: { id: "engine" } };
    (mesh as unknown as { _scene: unknown })._scene = withEngine ? { getEngine: () => engine } : undefined;
    return mesh;
}

describe("AbstractMesh.getIndices", () => {
    it("returns the retained Lite CPU index buffer", () => {
        const indices = new Uint32Array([0, 1, 2, 2, 1, 3]);
        expect(fakeMesh({ _cpuIndices: indices }).getIndices()).toBe(indices);
    });

    it("returns null when the mesh has no geometry", () => {
        expect(fakeMesh({}).getIndices()).toBeNull();
    });

    it("returns an independent array when forceCopy is true", () => {
        const indices = new Uint32Array([0, 1, 2]);
        const copy = fakeMesh({ _cpuIndices: indices }).getIndices(false, true)!;
        expect(copy).not.toBe(indices);
        expect(copy).toEqual(indices);
    });
});

describe("AbstractMesh.setIndices", () => {
    it("re-uploads with the new indices, keeping existing attributes", () => {
        resizeMeshGeometryMock.mockClear();
        const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
        const normals = new Float32Array(positions.length);
        const uvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
        const uvs2 = new Float32Array(uvs);
        const tangents = new Float32Array(16);
        const colors = new Float32Array(16);
        const mesh = fakeMesh({
            _cpuPositions: positions,
            _cpuNormals: normals,
            _cpuUvs: uvs,
            _cpuUv2s: uvs2,
            _cpuTangents: tangents,
            _cpuColors: colors,
            _cpuIndices: new Uint32Array([0, 1, 2]),
        });

        const result = mesh.setIndices([0, 1, 2, 2, 1, 3]);

        expect(result).toBe(mesh);
        expect(resizeMeshGeometryMock).toHaveBeenCalledTimes(1);
        const call = resizeMeshGeometryMock.mock.calls[0]!;
        expect(call[2]).toBe(positions);
        expect(call[3]).toBe(normals);
        const forwarded = call[4] as Uint32Array;
        expect(forwarded).toBeInstanceOf(Uint32Array);
        expect(Array.from(forwarded)).toEqual([0, 1, 2, 2, 1, 3]);
        expect(call[5]).toBe(uvs);
        expect(call[6]).toBe(uvs2);
        expect(call[7]).toBe(tangents);
        expect(call[8]).toBe(colors);
    });

    it("forwards a Uint32Array argument without copying", () => {
        resizeMeshGeometryMock.mockClear();
        const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        const indices = new Uint32Array([0, 1, 2]);
        const mesh = fakeMesh({ _cpuPositions: positions, _cpuNormals: new Float32Array(9), _cpuIndices: new Uint32Array([0, 1, 2]) });
        mesh.setIndices(indices);
        expect(resizeMeshGeometryMock.mock.calls[0]![4]).toBe(indices);
    });

    it("is a no-op returning the mesh when there is no engine", () => {
        resizeMeshGeometryMock.mockClear();
        const mesh = fakeMesh({ _cpuPositions: new Float32Array(9), _cpuIndices: new Uint32Array([0, 1, 2]) }, false);
        expect(mesh.setIndices([0, 1, 2])).toBe(mesh);
        expect(resizeMeshGeometryMock).not.toHaveBeenCalled();
    });

    it("is a no-op when the mesh has no positions", () => {
        resizeMeshGeometryMock.mockClear();
        const mesh = fakeMesh({});
        expect(mesh.setIndices([0, 1, 2])).toBe(mesh);
        expect(resizeMeshGeometryMock).not.toHaveBeenCalled();
    });

    it("regenerates placeholder attributes for a positions-then-indices vertex-count change", () => {
        resizeMeshGeometryMock.mockImplementation(
            (_engine, lite, positions, normals, indices, uvs, uvs2, tangents, colors) => {
                Object.assign(lite, {
                    _cpuPositions: positions,
                    _cpuNormals: normals,
                    _cpuIndices: indices,
                    _cpuUvs: uvs,
                    _cpuUv2s: uvs2 ?? null,
                    _cpuTangents: tangents ?? null,
                    _cpuColors: colors ?? null,
                });
            }
        );
        const lite = {
            name: "shape",
            children: [],
            receiveShadows: false,
            _cpuPositions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            _cpuNormals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
            _cpuUvs: new Float32Array([0, 0, 1, 0, 0, 1]),
            _cpuIndices: new Uint32Array([0, 1, 2]),
        };
        const scene = {
            defaultMaterial: null,
            getEngine: () => ({ _lite: { id: "engine" } }),
            _registerMesh: vi.fn(),
        };
        const mesh = new Mesh("shape", lite as never, scene as never);

        mesh.setVerticesData(VertexBuffer.PositionKind, [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
        mesh.setIndices([0, 1, 2, 2, 1, 3]);

        const lastCall = resizeMeshGeometryMock.mock.calls.at(-1)!;
        expect(lastCall[2]).toHaveLength(12);
        expect(lastCall[3]).toHaveLength(12);
        expect(lastCall[5]).toHaveLength(8);
        expect(Array.from(lastCall[3] as Float32Array).slice(9, 12)).not.toEqual([0, 0, 0]);
    });
});
