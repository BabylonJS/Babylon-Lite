import {
    createFindNearestPolyResult,
    findNearestPoly,
    findPath,
    raycast,
    moveAlongSurface,
    getNodeByRef,
    isValidNodeRef,
    getClosestPointOnPoly,
    createGetClosestPointOnPolyResult,
} from "navcat";
import type { NavMesh, QueryFilter } from "navcat";
import type { Vec3, Vec3Tuple } from "../math/types.js";
import type { NavcatManager, NavcatNode, NavcatLocation, NavcatNearestResult, NavcatPathResult, NavcatRaycastResult, NavcatMoveResult } from "./navcat-types.js";
import { copyNavcatVector, fromNavcat, toNavcat, navcatQuery } from "./navcat-state.js";

function nodeInfo(mesh: NavMesh, ref: number): NavcatNode {
    const node = getNodeByRef(mesh, ref);
    return { nodeRef: ref, flags: node.flags, area: node.area, kind: node.type === 0 ? "polygon" : "connection" };
}

function filterFor(manager: NavcatManager): QueryFilter {
    const filter = manager._filter!;
    return {
        passFilter(ref, mesh) {
            const flags = getNodeByRef(mesh, ref).flags;
            return (flags & filter.includeFlags!) !== 0 && (flags & filter.excludeFlags!) === 0 && (filter.pass?.(nodeInfo(mesh, ref)) ?? true);
        },
        getCost(a, b, mesh, prev, current, next) {
            const cost =
                filter.cost?.(
                    fromNavcat(a),
                    fromNavcat(b),
                    nodeInfo(mesh, current),
                    prev === undefined ? null : nodeInfo(mesh, prev),
                    next === undefined ? null : nodeInfo(mesh, next)
                ) ?? Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
            if (!Number.isFinite(cost) || cost < 0) {
                throw new Error("Navcat cost must be finite and nonnegative");
            }
            return cost;
        },
    };
}

function extents(manager: NavcatManager, value?: Vec3): Vec3Tuple {
    const v = copyNavcatVector(value ?? manager._halfExtents!, "half extents", true);
    return [v.x, v.y, v.z];
}

function location(manager: NavcatManager, ref: number, position: readonly number[]): NavcatLocation {
    return { nodeRef: ref, position: fromNavcat(position), revision: manager._revision, _owner: manager };
}

function checkLocation(manager: NavcatManager, mesh: NavMesh, start: NavcatLocation): Vec3Tuple {
    if (
        start._owner !== manager ||
        start.revision !== manager._revision ||
        !Number.isSafeInteger(start.nodeRef) ||
        !isValidNodeRef(mesh, start.nodeRef) ||
        getNodeByRef(mesh, start.nodeRef).type !== 0
    ) {
        throw new Error("Navcat location is stale or belongs to another manager");
    }
    if (!filterFor(manager).passFilter(start.nodeRef, mesh)) {
        throw new Error("Navcat location is excluded by the current filter");
    }
    return toNavcat(start.position);
}

export function nearest(manager: NavcatManager, point: Vec3, halfExtents?: Vec3): NavcatNearestResult {
    return navcatQuery(manager, (mesh) => {
        const result = findNearestPoly(createFindNearestPolyResult(), mesh, toNavcat(point), extents(manager, halfExtents), filterFor(manager));
        return result.success ? { success: true, location: location(manager, result.nodeRef, result.position) } : { success: false };
    });
}

export function path(manager: NavcatManager, start: Vec3, end: Vec3, halfExtents?: Vec3): NavcatPathResult {
    return navcatQuery(manager, (mesh) => {
        const result = findPath(mesh, toNavcat(start), toNavcat(end), extents(manager, halfExtents), filterFor(manager));
        return {
            success: result.success,
            complete: result.success && (result.flags & 2) !== 0,
            points: result.success ? result.path.map((p) => ({ position: fromNavcat(p.position), nodeRef: p.nodeRef, offMesh: (p.flags & 2) !== 0 })) : [],
            nodeRefs: result.success ? (result.nodePath?.path.slice() ?? []) : [],
            revision: manager._revision,
            _owner: manager,
            _search: result.nodePath?.nodes ?? null,
        };
    });
}

export function ray(manager: NavcatManager, start: NavcatLocation, end: Vec3): NavcatRaycastResult {
    return navcatQuery(manager, (mesh) => {
        const a = checkLocation(manager, mesh, start);
        const b = toNavcat(end);
        const result = raycast(mesh, start.nodeRef, a, b, filterFor(manager));
        const hit = result.hitEdgeIndex >= 0 && result.t <= 1;
        const fraction = hit ? Math.max(0, Math.min(1, result.t)) : 1;
        const point: Vec3Tuple = [a[0] + (b[0] - a[0]) * fraction, a[1], a[2] + (b[2] - a[2]) * fraction];
        const last = result.path.at(-1) ?? start.nodeRef;
        const projected = getClosestPointOnPoly(createGetClosestPointOnPolyResult(), mesh, last, point);
        return {
            hit,
            fraction,
            position: fromNavcat(projected.success ? projected.position : point),
            normal: hit ? fromNavcat(result.hitNormal) : { x: 0, y: 0, z: 0 },
            nodeRefs: result.path.slice(),
        };
    });
}

export function move(manager: NavcatManager, start: NavcatLocation, end: Vec3): NavcatMoveResult {
    return navcatQuery(manager, (mesh) => {
        const result = moveAlongSurface(mesh, start.nodeRef, checkLocation(manager, mesh, start), toNavcat(end), filterFor(manager));
        return result.success ? { success: true, location: location(manager, result.nodeRef, result.position), visited: result.visited.slice() } : { success: false };
    });
}
