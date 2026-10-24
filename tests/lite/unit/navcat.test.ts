import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createNavcatManager, replaceNavcatMesh, exportNavcatMesh, setNavcatFilter, disposeNavcatManager } from "../../../packages/babylon-lite/src/navigation/navcat.js";
import { findNavcatNearestPoly, findNavcatPath, raycastNavcat, moveAlongNavcatSurface } from "../../../packages/babylon-lite/src/navigation/navcat-queries.js";
import { addNavcatConnection, removeNavcatConnection, isNavcatConnectionConnected } from "../../../packages/babylon-lite/src/navigation/navcat-connections.js";
import { createNavcatDebugGeometry } from "../../../packages/babylon-lite/src/navigation/navcat-debug.js";
import type { NavcatLocation, NavcatManager } from "../../../packages/babylon-lite/src/navigation/navcat-types.js";

const json = readFileSync(new URL("../../../lab/public/navcat/demo-navmesh.json", import.meta.url), "utf8");
const start = { x: -4, y: 0, z: 2 };
const end = { x: 4, y: 0, z: -2 };

function nearest(manager: NavcatManager, point = start): NavcatLocation {
    const result = findNavcatNearestPoly(manager, point);
    expect(result.success).toBe(true);
    if (!result.success) {
        throw new Error("Expected a nearest polygon");
    }
    return result.location;
}

function connectionOptions() {
    return { start: { x: -1.7, y: 0.1, z: 0 }, end: { x: 1.7, y: 0.1, z: 0 }, radius: 0.6 };
}

describe("Navcat real SDK queries and coordinates", () => {
    it("roundtrips RH JSON while keeping public queries and results in LH coordinates", async () => {
        const manager = await createNavcatManager(json);
        const snap = nearest(manager);
        expect(snap.position).toEqual({ x: -4, y: 0.1, z: 2 });
        const path = findNavcatPath(manager, start, end);
        expect(path.success).toBe(true);
        expect(path.complete).toBe(true);
        expect(path.points[0]!.position).toEqual(snap.position);
        expect(path.points.at(-1)!.position).toEqual({ x: 4, y: 0.1, z: -2 });
        expect(path.points.some((p) => p.position.z < -2.3)).toBe(true);
        expect(JSON.parse(exportNavcatMesh(manager))).toEqual(JSON.parse(json));
        disposeNavcatManager(manager);
    });

    it("accepts valid polygon reference zero and rejects empty nearest searches", async () => {
        const manager = await createNavcatManager(json);
        const zero = nearest(manager, { x: -0.3, y: 0, z: -3 });
        expect(zero.nodeRef).toBe(0);
        expect(moveAlongNavcatSurface(manager, zero, { x: -0.2, y: 0, z: -3 }).success).toBe(true);
        expect(findNavcatNearestPoly(manager, { x: 100, y: 0, z: 100 }, { x: 0, y: 0, z: 0 })).toEqual({ success: false });
        disposeNavcatManager(manager);
    });

    it("distinguishes blocked rays from the SDK's MAX_VALUE miss and projects height", async () => {
        const manager = await createNavcatManager(json);
        const snap = nearest(manager);
        const hit = raycastNavcat(manager, snap, end);
        expect(hit.hit).toBe(true);
        expect(hit.fraction).toBeCloseTo(0.33125);
        expect(hit.position.x).toBeCloseTo(-1.35);
        expect(hit.normal).toEqual({ x: -1, y: 0, z: 0 });
        const clear = raycastNavcat(manager, snap, { x: -3, y: 1000, z: 1 });
        expect(clear.hit).toBe(false);
        expect(clear.fraction).toBe(1);
        expect(clear.normal).toEqual({ x: 0, y: 0, z: 0 });
        expect(clear.position).toEqual({ x: -3, y: 0.1, z: 1 });
        disposeNavcatManager(manager);
    });

    it("constrains movement at the hole and returns owned snapshots", async () => {
        const manager = await createNavcatManager(json);
        const moved = moveAlongNavcatSurface(manager, nearest(manager), { x: 0, y: 0, z: 0 });
        expect(moved.success).toBe(true);
        if (moved.success) {
            expect(moved.location.position.x).toBeCloseTo(-1.35);
            expect(moved.location.position.y).toBeCloseTo(0.1);
            moved.location.position.x = 999;
            moved.visited.length = 0;
        }
        expect(nearest(manager).position.x).toBe(-4);
        disposeNavcatManager(manager);
    });

    it("applies flag masks, pass predicates, custom costs and partial-path status", async () => {
        const manager = await createNavcatManager(json);
        setNavcatFilter(manager, { includeFlags: 0 });
        expect(findNavcatNearestPoly(manager, start).success).toBe(false);
        setNavcatFilter(manager, { excludeFlags: 1 });
        expect(findNavcatNearestPoly(manager, start).success).toBe(false);
        setNavcatFilter(manager, null);
        const a = nearest(manager).nodeRef;
        const b = nearest(manager, end).nodeRef;
        setNavcatFilter(manager, { pass: (node) => node.nodeRef === a || node.nodeRef === b });
        const partial = findNavcatPath(manager, start, end);
        expect(partial.success).toBe(true);
        expect(partial.complete).toBe(false);
        let calls = 0;
        const options = {
            cost: (from: Readonly<{ x: number; y: number; z: number }>, to: Readonly<{ x: number; y: number; z: number }>) => {
                calls++;
                expect(from.z).toBeGreaterThanOrEqual(-4);
                return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) * 1.5;
            },
        };
        setNavcatFilter(manager, options);
        expect(findNavcatPath(manager, start, end).complete).toBe(true);
        expect(calls).toBeGreaterThan(0);
        setNavcatFilter(manager, { pass: () => false });
        const failed = findNavcatPath(manager, start, end);
        expect(failed).toMatchObject({ success: false, complete: false, points: [], nodeRefs: [] });
        disposeNavcatManager(manager);
    });

    it("changes the demo route when its authored area is blocked or expensive", async () => {
        const manager = await createNavcatManager(json);
        const normal = findNavcatPath(manager, start, end);
        setNavcatFilter(manager, { pass: (node) => node.area !== 2 });
        const blocked = findNavcatPath(manager, start, end);
        expect(blocked.complete).toBe(true);
        expect(blocked.points.map((p) => p.position)).not.toEqual(normal.points.map((p) => p.position));
        setNavcatFilter(manager, { cost: (a, b, node) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * (node.area === 2 ? 4 : 1) });
        const weighted = findNavcatPath(manager, start, end);
        expect(weighted.complete).toBe(true);
        expect(weighted.points.map((p) => p.position)).not.toEqual(normal.points.map((p) => p.position));
        disposeNavcatManager(manager);
    });

    it("rejects a previously snapped start after its polygon is filtered out", async () => {
        const manager = await createNavcatManager(json);
        const location = nearest(manager);
        setNavcatFilter(manager, { pass: () => false });
        expect(() => raycastNavcat(manager, location, end)).toThrow("excluded by the current filter");
        expect(() => moveAlongNavcatSurface(manager, location, end)).toThrow("excluded by the current filter");
        disposeNavcatManager(manager);
    });

    it("copies factory vectors and filter options before awaiting the runtime", async () => {
        const halfExtents = { x: 1, y: 2, z: 1 };
        const filter = { includeFlags: 1 };
        const pending = createNavcatManager(json, { halfExtents, filter });
        halfExtents.x = 0;
        filter.includeFlags = 0;
        const manager = await pending;
        expect(nearest(manager).position.x).toBe(-4);
        expect(manager._halfExtents!.x).toBe(1);
        disposeNavcatManager(manager);
    });

    it.each([NaN, Infinity, -1])("rejects invalid callback cost %s and recovers", async (cost) => {
        const manager = await createNavcatManager(json);
        setNavcatFilter(manager, { cost: () => cost });
        expect(() => findNavcatPath(manager, start, end)).toThrow("cost must be finite and nonnegative");
        setNavcatFilter(manager, null);
        expect(findNavcatPath(manager, start, end).complete).toBe(true);
        disposeNavcatManager(manager);
    });

    it.each(["query", "replace", "dispose", "filter"])("rejects callback %s reentry, then releases SDK scratch ownership", async (operation) => {
        const manager = await createNavcatManager(json);
        const other = await createNavcatManager(json);
        setNavcatFilter(manager, {
            pass: () => {
                if (operation === "query") {
                    findNavcatNearestPoly(other, start);
                }
                if (operation === "replace") {
                    replaceNavcatMesh(manager, json);
                }
                if (operation === "dispose") {
                    disposeNavcatManager(manager);
                }
                if (operation === "filter") {
                    setNavcatFilter(manager, null);
                }
                return true;
            },
        });
        expect(() => findNavcatNearestPoly(manager, start)).toThrow("cannot run nested queries or mutate");
        setNavcatFilter(manager, null);
        expect(nearest(manager).position.x).toBe(-4);
        disposeNavcatManager(manager);
        disposeNavcatManager(other);
    });

    it.each([NaN, Infinity])("rejects nonfinite query coordinates %s", async (x) => {
        const manager = await createNavcatManager(json);
        expect(() => findNavcatNearestPoly(manager, { x, y: 0, z: 0 })).toThrow("finite");
        expect(() => findNavcatPath(manager, start, end, { x: -1, y: 1, z: 1 })).toThrow("nonnegative");
        disposeNavcatManager(manager);
    });
});

describe("Navcat replacement, ownership and teardown", () => {
    it("publishes replacement atomically and invalidates prior/foreign locations", async () => {
        const manager = await createNavcatManager(json);
        const other = await createNavcatManager(json);
        const old = nearest(manager);
        expect(() => replaceNavcatMesh(manager, "{}")).toThrow("Invalid Navcat JSON");
        expect(raycastNavcat(manager, old, end).hit).toBe(true);
        expect(() => moveAlongNavcatSurface(other, old, end)).toThrow("another manager");
        replaceNavcatMesh(manager, json);
        expect(() => raycastNavcat(manager, old, end)).toThrow("stale");
        expect(findNavcatPath(manager, start, end).complete).toBe(true);
        disposeNavcatManager(manager);
        disposeNavcatManager(other);
    });

    it.each(["null", "[]", "{", "{}"])("rejects malformed JSON %s", async (value) => {
        await expect(createNavcatManager(value)).rejects.toThrow("Invalid Navcat JSON");
    });

    it("clears every owned reference on idempotent disposal and can reload independently", async () => {
        const manager = await createNavcatManager(json, { filter: { pass: () => true } });
        const old = nearest(manager);
        disposeNavcatManager(manager);
        disposeNavcatManager(manager);
        expect([manager._mesh, manager._api, manager._filter, manager._halfExtents]).toEqual([null, null, null, null]);
        expect(() => findNavcatNearestPoly(manager, start)).toThrow("disposed");
        expect(() => findNavcatPath(manager, start, end)).toThrow("disposed");
        expect(() => raycastNavcat(manager, old, end)).toThrow("disposed");
        expect(() => moveAlongNavcatSurface(manager, old, end)).toThrow("disposed");
        expect(() => exportNavcatMesh(manager)).toThrow("disposed");
        expect(() => replaceNavcatMesh(manager, json)).toThrow("disposed");
        expect(() => setNavcatFilter(manager, null)).toThrow("disposed");
        await expect(createNavcatDebugGeometry(manager)).rejects.toThrow("disposed");
        await expect(addNavcatConnection(manager, connectionOptions())).rejects.toThrow("disposed");
        const reload = await createNavcatManager(json);
        expect(nearest(reload).position.x).toBe(-4);
        disposeNavcatManager(reload);
    });
});

describe("Navcat optional connections and debug", () => {
    it("adds ID0, traverses/removes a link and rejects reused/stale/foreign handles", async () => {
        const manager = await createNavcatManager(json);
        const other = await createNavcatManager(json);
        const oldLocation = nearest(manager);
        const link = await addNavcatConnection(manager, connectionOptions());
        expect(link.id).toBe(0);
        expect(await isNavcatConnectionConnected(manager, link)).toBe(true);
        const path = findNavcatPath(manager, { x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 });
        expect(path.points.some((p) => p.offMesh)).toBe(true);
        expect(() => raycastNavcat(manager, oldLocation, end)).toThrow("stale");
        expect(await removeNavcatConnection(other, link)).toBe(false);
        expect(await removeNavcatConnection(manager, link)).toBe(true);
        expect(await removeNavcatConnection(manager, link)).toBe(false);
        expect(await isNavcatConnectionConnected(manager, link)).toBe(false);
        const reused = await addNavcatConnection(manager, connectionOptions());
        expect(reused.id).toBe(link.id);
        expect(await removeNavcatConnection(manager, link)).toBe(false);
        expect(await isNavcatConnectionConnected(manager, reused)).toBe(true);
        replaceNavcatMesh(manager, json);
        expect(await removeNavcatConnection(manager, reused)).toBe(false);
        disposeNavcatManager(manager);
        disposeNavcatManager(other);
    });

    it("copies async connection inputs and refuses mutations after replacement/disposal", async () => {
        const manager = await createNavcatManager(json);
        const options = connectionOptions();
        const pending = addNavcatConnection(manager, options);
        options.start.x = 999;
        const link = await pending;
        expect(await isNavcatConnectionConnected(manager, link)).toBe(true);
        const replacing = addNavcatConnection(manager, connectionOptions());
        replaceNavcatMesh(manager, json);
        await expect(replacing).rejects.toThrow("replaced");
        const disposing = addNavcatConnection(manager, connectionOptions());
        disposeNavcatManager(manager);
        await expect(disposing).rejects.toThrow("disposed");
    });

    it("returns copied mesh/link/search primitives and rejects stale searches", async () => {
        const manager = await createNavcatManager(json);
        const search = findNavcatPath(manager, start, end, undefined, { keepSearch: true });
        const debug = await createNavcatDebugGeometry(manager, { search });
        expect(debug.some((p) => p.kind === "triangles")).toBe(true);
        expect(debug.some((p) => p.kind === "lines")).toBe(true);
        expect(debug.some((p) => p.kind === "points")).toBe(true);
        const saved = debug[0]!.positions[0];
        debug[0]!.positions[0] = 999;
        expect((await createNavcatDebugGeometry(manager))[0]!.positions[0]).toBe(saved);
        const pending = createNavcatDebugGeometry(manager, { search });
        replaceNavcatMesh(manager, json);
        await expect(pending).rejects.toThrow("replaced");
        await expect(createNavcatDebugGeometry(manager, { search })).rejects.toThrow("stale");
        disposeNavcatManager(manager);
    });
});
