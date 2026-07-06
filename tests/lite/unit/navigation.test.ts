import { describe, expect, it } from "vitest";
import { createNavMeshFromSources, findClosestPointWithin } from "../../../packages/babylon-lite/src/navigation/navigation";
import type { NavigationPlugin, NavMeshSource } from "../../../packages/babylon-lite/src/navigation/navigation";

function createMockPlugin(capture: { positions?: number[]; indices?: number[]; navMeshQueryInput?: unknown }): NavigationPlugin {
    const navMesh = { ok: true };
    return {
        _recast: {
            NavMeshQuery: class {
                constructor(input: unknown) {
                    capture.navMeshQueryInput = input;
                }
            },
        },
        _generators: {
            generateSoloNavMesh(positions: Float32Array, indices: Uint32Array) {
                capture.positions = Array.from(positions);
                capture.indices = Array.from(indices);
                return { success: true, navMesh };
            },
        },
    };
}

describe("navigation raw sources", () => {
    it("builds a navmesh from raw sources with reversed winding and base-index offsets", () => {
        const capture: { positions?: number[]; indices?: number[]; navMeshQueryInput?: unknown } = {};
        const plugin = createMockPlugin(capture);
        const sources: NavMeshSource[] = [
            { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 1, 2] },
            { positions: [10, 0, 0, 11, 0, 0, 10, 0, 1], indices: [0, 1, 2] },
        ];

        createNavMeshFromSources(plugin, sources, {});

        expect(capture.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 1, 10, 0, 0, 11, 0, 0, 10, 0, 1]);
        expect(capture.indices).toEqual([0, 2, 1, 3, 5, 4]);
        expect(capture.navMeshQueryInput).toEqual({ ok: true });
    });

    it("preserves raw source winding when requested", () => {
        const capture: { positions?: number[]; indices?: number[] } = {};
        const plugin = createMockPlugin(capture);

        createNavMeshFromSources(plugin, [{ positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 1, 2] }], { doNotReverseIndices: true });

        expect(capture.indices).toEqual([0, 1, 2]);
    });
});

describe("findClosestPointWithin", () => {
    function makeReadyPlugin(findClosestPoint: (position: unknown, opts: unknown) => unknown): NavigationPlugin {
        return { _navMesh: { ok: true }, _navMeshQuery: { findClosestPoint } } as unknown as NavigationPlugin;
    }

    it("returns the snapped point and forwards the caller's halfExtents", () => {
        let seen: unknown;
        const plugin = makeReadyPlugin((_position, opts) => {
            seen = opts;
            return { success: true, point: { x: 1, y: 2, z: 3 } };
        });

        const result = findClosestPointWithin(plugin, { x: 1.1, y: 2, z: 3 }, { x: 5, y: 4, z: 5 });

        expect(result).toEqual({ x: 1, y: 2, z: 3 });
        expect(seen).toEqual({ halfExtents: { x: 5, y: 4, z: 5 } });
    });

    it("returns null when the query finds nothing inside the box", () => {
        const plugin = makeReadyPlugin(() => ({ success: false, point: { x: 0, y: 0, z: 0 } }));

        expect(findClosestPointWithin(plugin, { x: 99, y: 0, z: 99 }, { x: 1, y: 1, z: 1 })).toBeNull();
    });
});
