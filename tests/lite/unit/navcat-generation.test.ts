import { describe, expect, it } from "vitest";
import { createFlatGroundData } from "../../../packages/babylon-lite/src/mesh/create-ground.js";
import { extractNavcatGeometry } from "../../../packages/babylon-lite/src/navigation/navcat-geometry.js";
import { generateNavcatMesh } from "../../../packages/babylon-lite/src/navigation/navcat-generation.js";
import { createNavcatManager, disposeNavcatManager } from "../../../packages/babylon-lite/src/navigation/navcat.js";
import { findNavcatNearestPoly } from "../../../packages/babylon-lite/src/navigation/navcat-queries.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import type { NavcatBuildOptions, NavcatGeometry } from "../../../packages/babylon-lite/src/navigation/navcat-types.js";

function ground(sx = 1, sz = 1, authored = 1): Mesh {
    const data = createFlatGroundData({ width: 12, height: 8, subdivisions: 2 });
    // A glTF-authored RH ground has the opposite local winding and its root Z flip.
    if (authored === -1) {
        for (let i = 0; i < data.indices.length; i += 3) {
            [data.indices[i + 1], data.indices[i + 2]] = [data.indices[i + 2]!, data.indices[i + 1]!];
        }
    }
    return {
        _cpuPositions: data.positions,
        _cpuIndices: data.indices,
        _authoredSign: authored,
        worldMatrix: new Float64Array([sx, 0, 0, 0, 0, 1, 0, 0, 0, 0, sz, 0, 7, 2, 5, 1]),
    } as unknown as Mesh;
}

async function generatedNearest(geometry: NavcatGeometry) {
    const manager = await createNavcatManager(await generateNavcatMesh(geometry));
    const result = findNavcatNearestPoly(manager, { x: 8, y: 2, z: 6 });
    disposeNavcatManager(manager);
    return result;
}

describe("Navcat extraction and real solo generation", () => {
    it.each([
        [1, 1, 1],
        [-1, 1, 1],
        [2, 3, 1],
        [1, -1, -1],
        [-1, -1, -1],
    ])("preserves authored front faces for scale %s/%s, authored sign %s", async (sx, sz, authored) => {
        const mesh = ground(sx, sz, authored);
        const originalPositions = mesh._cpuPositions!.slice();
        const originalIndices = mesh._cpuIndices!.slice();
        const result = await generatedNearest(extractNavcatGeometry([mesh]));
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.location.position.x).toBeCloseTo(8);
            expect(result.location.position.y).toBeCloseTo(2.1);
            expect(result.location.position.z).toBeCloseTo(6);
        }
        expect(mesh._cpuPositions).toEqual(originalPositions);
        expect(mesh._cpuIndices).toEqual(originalIndices);
    });

    it("merges with vertex offsets and retains float64 world translation", () => {
        const mesh = ground();
        const matrix = mesh.worldMatrix as unknown as Float64Array;
        matrix[12] = 1e9 + 0.125;
        const result = extractNavcatGeometry([mesh, ground()]);
        expect(result.positions).toBeInstanceOf(Float64Array);
        expect(result.positions[0]).toBe(1e9 - 6 + 0.125);
        expect(result.indices[mesh._cpuIndices!.length]).toBe(mesh._cpuPositions!.length / 3 + mesh._cpuIndices![0]!);
    });

    it.each(["retired", "positions", "indices", "topology", "gltf-topology", "skeleton", "morph", "vat", "instances", "singular", "nonfinite", "invalid-index"])(
        "rejects unsupported or invalid %s source",
        (kind) => {
            const mesh = ground();
            if (kind === "retired") {
                mesh._disposed = true;
            }
            if (kind === "positions") {
                mesh._cpuPositions = undefined;
            }
            if (kind === "indices") {
                mesh._cpuIndices = undefined;
            }
            if (kind === "topology") {
                mesh._topology = 4;
            }
            if (kind === "gltf-topology") {
                (mesh as Mesh & { _primitive?: { topology: string } })._primitive = { topology: "line-list" };
            }
            if (kind === "skeleton") {
                mesh.skeleton = {} as NonNullable<Mesh["skeleton"]>;
            }
            if (kind === "morph") {
                mesh.morphTargets = {} as NonNullable<Mesh["morphTargets"]>;
            }
            if (kind === "vat") {
                mesh.vat = {} as NonNullable<Mesh["vat"]>;
            }
            if (kind === "instances") {
                mesh.thinInstances = {} as NonNullable<Mesh["thinInstances"]>;
            }
            if (kind === "singular") {
                (mesh.worldMatrix as unknown as Float64Array)[0] = 0;
            }
            if (kind === "nonfinite") {
                mesh._cpuPositions![0] = NaN;
            }
            if (kind === "invalid-index") {
                mesh._cpuIndices![0] = 999;
            }
            expect(() => extractNavcatGeometry([mesh])).toThrow("Navcat");
        }
    );

    it("rejects an empty source list", () => {
        expect(() => extractNavcatGeometry([])).toThrow("at least one mesh");
    });

    it("snapshots generation arrays/options before awaiting imports", async () => {
        const geometry = extractNavcatGeometry([ground()]);
        const options = { cellHeight: 0.2, agentRadius: 0.2, agentHeight: 1.4, maxClimb: 0.6 };
        const pending = generateNavcatMesh(geometry, options);
        geometry.positions.fill(0);
        geometry.indices.fill(999);
        options.cellHeight = -1;
        const json = await pending;
        const parsed = JSON.parse(json) as { tiles: Record<string, { cellHeight: number; walkableRadius: number; walkableHeight: number; walkableClimb: number }> };
        expect(Object.values(parsed.tiles)[0]).toMatchObject({ cellHeight: 0.2, walkableRadius: 0.2, walkableHeight: 1.4, walkableClimb: 0.6 });
        const manager = await createNavcatManager(json);
        expect(findNavcatNearestPoly(manager, { x: 8, y: 2, z: 6 }).success).toBe(true);
        disposeNavcatManager(manager);
    });

    it.each([{ cellSize: 0 }, { cellHeight: NaN }, { agentHeight: -1 }, { maxSlope: 91 }, { maxVerticesPerPoly: 7 }, { maxVerticesPerPoly: 3.5 }] satisfies NavcatBuildOptions[])(
        "rejects invalid physical options %j",
        async (options) => {
            await expect(generateNavcatMesh(extractNavcatGeometry([ground()]), options)).rejects.toThrow("Invalid Navcat");
        }
    );

    it("rejects malformed direct generation geometry", async () => {
        await expect(generateNavcatMesh({ positions: new Float64Array(3), indices: new Uint32Array(0) })).rejects.toThrow("indexed triangles");
        const geometry = extractNavcatGeometry([ground()]);
        geometry.positions[0] = Infinity;
        await expect(generateNavcatMesh(geometry)).rejects.toThrow("nonfinite");
    });
});
