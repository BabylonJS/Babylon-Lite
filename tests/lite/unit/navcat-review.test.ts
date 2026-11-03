import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as SDK from "../../../packages/babylon-lite/node_modules/navcat";
import { createNavcatManager, disposeNavcatManager, setNavcatFilter } from "../../../packages/babylon-lite/src/navigation/navcat.js";
import { findNavcatNearestPoly, findNavcatPath, raycastNavcat } from "../../../packages/babylon-lite/src/navigation/navcat-queries.js";
import type { NavcatManager, NavcatNode } from "../../../packages/babylon-lite/src/navigation/navcat-types.js";
import type { Vec3 } from "../../../packages/babylon-lite/src/math/types.js";

// Observe adapter allocation boundaries while every query still executes the real pinned SDK.
vi.mock("../../../packages/babylon-lite/node_modules/navcat", async (importOriginal) => {
    const sdk = await importOriginal<typeof SDK>();
    return { ...sdk, findNearestPoly: vi.fn(sdk.findNearestPoly), getClosestPointOnPoly: vi.fn(sdk.getClosestPointOnPoly), findPath: vi.fn(sdk.findPath) };
});

const json = readFileSync(new URL("../../../lab/public/navcat/demo-navmesh.json", import.meta.url), "utf8");
const start = { x: -4, y: 0, z: 2 };
const end = { x: 4, y: 0, z: -2 };
const managers: NavcatManager[] = [];

async function manager(): Promise<NavcatManager> {
    const result = await createNavcatManager(json);
    managers.push(result);
    return result;
}

afterEach(() => {
    managers.splice(0).forEach(disposeNavcatManager);
    vi.clearAllMocks();
});

describe("Navcat query allocation and lifetime contracts", () => {
    it("delegates default filters directly and rebuilds custom filters only on assignment", async () => {
        const nav = await manager();
        expect(nav._queryFilter).toBe(SDK.DEFAULT_QUERY_FILTER);
        setNavcatFilter(nav, { includeFlags: 0 });
        const excluded = nav._queryFilter;
        expect(findNavcatNearestPoly(nav, start).success).toBe(false);
        expect(nav._queryFilter).toBe(excluded);
        setNavcatFilter(nav, { pass: () => true });
        const custom = nav._queryFilter;
        expect(custom).not.toBe(excluded);
        expect(findNavcatPath(nav, start, end).complete).toBe(true);
        expect(findNavcatPath(nav, start, end).complete).toBe(true);
        expect(nav._queryFilter).toBe(custom);
        expect(vi.mocked(SDK.findPath).mock.calls.every((call) => call[4] === custom)).toBe(true);
        setNavcatFilter(nav, null);
        expect(nav._queryFilter).toBe(SDK.DEFAULT_QUERY_FILTER);
        expect(SDK.DEFAULT_QUERY_FILTER.includeFlags).toBe(0xffffffff);
        expect(SDK.DEFAULT_QUERY_FILTER.excludeFlags).toBe(0);
    });

    it("reuses bounded callback views and preserves distinct vector and adjacent-node values", async () => {
        const nav = await manager();
        const passNodes = new Set<Readonly<NavcatNode>>();
        const currentNodes = new Set<Readonly<NavcatNode>>();
        const previousNodes = new Set<Readonly<NavcatNode>>();
        const nextNodes = new Set<Readonly<NavcatNode>>();
        const fromVectors = new Set<Readonly<Vec3>>();
        const toVectors = new Set<Readonly<Vec3>>();
        const visitedRefs = new Set<number>();
        const fromPositions = new Set<string>();
        setNavcatFilter(nav, {
            pass(node) {
                passNodes.add(node);
                visitedRefs.add(node.nodeRef);
                expect(node.kind).toBe("polygon");
                return true;
            },
            cost(from, to, current, previous, next) {
                fromVectors.add(from);
                toVectors.add(to);
                fromPositions.add(JSON.stringify(from));
                currentNodes.add(current);
                if (previous) {
                    previousNodes.add(previous);
                    expect(previous).not.toBe(current);
                }
                if (next) {
                    nextNodes.add(next);
                    expect(next).not.toBe(current);
                    expect(next).not.toBe(previous);
                }
                expect(from).not.toBe(to);
                return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
            },
        });
        expect(findNavcatPath(nav, start, end).complete).toBe(true);
        expect(findNavcatPath(nav, end, start).complete).toBe(true);
        expect(visitedRefs.size).toBeGreaterThan(1);
        expect(fromPositions.size).toBeGreaterThan(1);
        expect([passNodes.size, currentNodes.size, previousNodes.size, nextNodes.size, fromVectors.size, toVectors.size]).toEqual([1, 1, 1, 1, 1, 1]);
    });

    it("does not retain the A* graph unless search debugging is explicitly requested", async () => {
        const nav = await manager();
        const ordinary = findNavcatPath(nav, start, end);
        expect(ordinary.complete).toBe(true);
        expect(ordinary._search).toBeNull();
        const debug = findNavcatPath(nav, start, end, undefined, { keepSearch: true });
        expect(debug.complete).toBe(true);
        expect(Object.keys(debug._search!).length).toBeGreaterThan(0);
        const retained = debug._search;
        const points = structuredClone(debug.points);
        const next = findNavcatPath(nav, end, start, undefined, { keepSearch: true });
        expect(next._search).not.toBe(retained);
        expect(debug._search).toBe(retained);
        expect(debug.points).toEqual(points);
        expect(findNavcatPath(nav, start, end, undefined, { keepSearch: false })._search).toBeNull();
    });

    it("reuses SDK nearest/closest results and default extents while returning owned snapshots", async () => {
        const nav = await manager();
        const first = findNavcatNearestPoly(nav, start);
        expect(first.success).toBe(true);
        if (!first.success) {
            throw new Error("Expected a polygon");
        }
        const saved = { ...first.location.position };
        findNavcatNearestPoly(nav, end, { x: 1, y: 2, z: 1 });
        findNavcatNearestPoly(nav, end);
        const calls = vi.mocked(SDK.findNearestPoly).mock.calls;
        expect(new Set(calls.map((call) => call[0])).size).toBe(1);
        expect(calls[0]![3]).toBe(nav._halfExtentsTuple);
        expect(calls[2]![3]).toBe(calls[0]![3]);
        expect(calls[1]![3]).not.toBe(calls[0]![3]);
        expect(nav._halfExtentsTuple).toEqual([1, 2, 1]);
        expect(() => findNavcatNearestPoly(nav, start, { x: -1, y: 2, z: 1 })).toThrow("nonnegative");
        raycastNavcat(nav, first.location, end);
        raycastNavcat(nav, first.location, { x: -3, y: 100, z: 1 });
        expect(new Set(vi.mocked(SDK.getClosestPointOnPoly).mock.calls.map((call) => call[0])).size).toBe(1);
        expect(first.location.position).toEqual(saved);
        disposeNavcatManager(nav);
        expect(nav._queryFilter).toBeNull();
        expect(nav._halfExtentsTuple).toBeNull();
    });
});
