import { describe, expect, it } from "vitest";
import {
    createNavMeshFromSources,
    findClosestPointWithin,
    findClosestPointWithinInto,
    navRayBlocked,
    navRayBlockedFast,
} from "../../../packages/babylon-lite/src/navigation/navigation";
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

interface FastRef {
    value: number;
}

interface FastPoint {
    x: number;
    y: number;
    z: number;
}

interface FastHit {
    t: number;
}

interface FastRawQuery {
    findClosestPoint?: (position: number[], extents: number[], filter: object, polyRef: FastRef, point: FastPoint, overPoly: FastRef) => number;
    findNearestPoly?: (position: number[], extents: number[], filter: object, polyRef: FastRef, point: FastPoint, overPoly: FastRef) => number;
    raycast?: (polyRef: number, start: number[], end: number[], filter: object, options: number, hit: FastHit, previousRef: number) => number;
}

function makeFastReadyPlugin(rawQuery: FastRawQuery): NavigationPlugin {
    class Ref implements FastRef {
        public value = 0;
    }
    class Point implements FastPoint {
        public x = 0;
        public y = 0;
        public z = 0;
    }
    class Hit implements FastHit {
        public t = 0;
    }
    return {
        _recast: {
            Raw: {
                UnsignedIntRef: Ref,
                Vec3: Point,
                BoolRef: Ref,
                Module: { dtRaycastHit: Hit },
                Detour: { statusSucceed: (status: number) => status === 1 },
            },
        },
        _generators: {},
        _navMesh: { ok: true },
        _navMeshQuery: {
            defaultFilter: { raw: {} },
            raw: rawQuery,
        },
    } as unknown as NavigationPlugin;
}

describe("findClosestPointWithinInto", () => {
    it("writes the snapped point and returns true on success", () => {
        const plugin = makeFastReadyPlugin({
            findClosestPoint(_position, _extents, _filter, polyRef, point) {
                polyRef.value = 7;
                point.x = 1;
                point.y = 2;
                point.z = 3;
                return 1;
            },
        });
        const out = { x: 9, y: 9, z: 9 };

        expect(findClosestPointWithinInto(plugin, { x: 1.1, y: 2, z: 3 }, { x: 5, y: 4, z: 5 }, out)).toBe(true);
        expect(out).toEqual({ x: 1, y: 2, z: 3 });
    });

    it.each([
        ["failed status", 0, 7],
        ["missing polygon reference", 1, 0],
    ])("returns false without writing out for a %s", (_label, status, ref) => {
        const plugin = makeFastReadyPlugin({
            findClosestPoint(_position, _extents, _filter, polyRef, point) {
                polyRef.value = ref;
                point.x = 1;
                point.y = 2;
                point.z = 3;
                return status;
            },
        });
        const out = { x: 9, y: 9, z: 9 };

        expect(findClosestPointWithinInto(plugin, { x: 99, y: 0, z: 99 }, { x: 1, y: 1, z: 1 }, out)).toBe(false);
        expect(out).toEqual({ x: 9, y: 9, z: 9 });
    });
});

describe("navRayBlocked", () => {
    const start = { x: 0, y: 0, z: 0 };
    const end = { x: 2, y: 0, z: 0 };

    function makeReadyPlugin(raycastResult: { success?: boolean; t?: number } | undefined, nearest = { success: true, nearestRef: 1 }): NavigationPlugin {
        return {
            _recast: {},
            _generators: {},
            _navMesh: { ok: true },
            _navMeshQuery: {
                findNearestPoly: () => nearest,
                raycast: () => raycastResult,
            },
        };
    }

    it("returns false only when Detour reports that the full segment was reached", () => {
        expect(navRayBlocked(makeReadyPlugin({ success: true, t: Number.MAX_VALUE }), start, end)).toBe(false);
    });

    it.each([
        ["a failed raycast", { success: false, t: Number.MAX_VALUE }],
        ["a non-finite distance", { success: true, t: Number.POSITIVE_INFINITY }],
        ["a wall at the origin", { success: true, t: 0 }],
        ["a wall inside the segment", { success: true, t: 0.5 }],
        ["a wall at the endpoint", { success: true, t: 1 }],
        ["a missing distance", { success: true }],
        ["an invalid distance", { success: true, t: Number.NaN }],
        ["a missing raycast result", undefined],
    ])("fails closed for %s", (_label, result) => {
        expect(navRayBlocked(makeReadyPlugin(result), start, end)).toBe(true);
    });

    it.each([
        ["failed lookup", { success: false, nearestRef: 1 }],
        ["missing polygon reference", { success: true, nearestRef: 0 }],
    ])("fails closed for an unresolved start polygon: %s", (_label, nearest) => {
        expect(navRayBlocked(makeReadyPlugin({ success: true, t: Number.MAX_VALUE }, nearest), start, end)).toBe(true);
    });
});

describe("navRayBlockedFast", () => {
    const start = { x: 0, y: 0, z: 0 };
    const end = { x: 2, y: 0, z: 0 };

    function makePlugin(options: { nearestStatus?: number; nearestRef?: number; rayStatus?: number; t?: number }): NavigationPlugin {
        return makeFastReadyPlugin({
            findNearestPoly(_position, _extents, _filter, polyRef) {
                polyRef.value = options.nearestRef ?? 1;
                return options.nearestStatus ?? 1;
            },
            raycast(_ref, _start, _end, _filter, _options, hit) {
                hit.t = options.t ?? Number.MAX_VALUE;
                return options.rayStatus ?? 1;
            },
        });
    }

    it("returns false only when Detour reports that the full segment was reached", () => {
        expect(navRayBlockedFast(makePlugin({}), start, end)).toBe(false);
    });

    it.each([
        ["failed polygon lookup", { nearestStatus: 0, nearestRef: 1 }],
        ["missing polygon reference", { nearestStatus: 1, nearestRef: 0 }],
        ["failed raycast", { rayStatus: 0, t: Number.MAX_VALUE }],
        ["non-finite distance", { t: Number.POSITIVE_INFINITY }],
        ["wall at the origin", { t: 0 }],
        ["wall inside the segment", { t: 0.5 }],
        ["wall at the endpoint", { t: 1 }],
        ["invalid distance", { t: Number.NaN }],
    ])("fails closed for a %s", (_label, options) => {
        expect(navRayBlockedFast(makePlugin(options), start, end)).toBe(true);
    });
});
