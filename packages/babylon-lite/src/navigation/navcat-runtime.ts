import {
    DEFAULT_QUERY_FILTER,
    createDefaultQueryFilter,
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
import type {
    NavcatFilter,
    NavcatManager,
    NavcatNode,
    NavcatLocation,
    NavcatNearestResult,
    NavcatPathOptions,
    NavcatPathResult,
    NavcatRaycastResult,
    NavcatMoveResult,
} from "./navcat-types.js";
import { validateNavcatVector, fromNavcat, toNavcat, navcatQuery } from "./navcat-state.js";

type NodeScratch = { -readonly [Key in keyof NavcatNode]: NavcatNode[Key] };

// Shared only inside the non-reentrant query guard; callbacks may borrow these during their call.
const _from: Vec3 = { x: 0, y: 0, z: 0 };
const _to: Vec3 = { x: 0, y: 0, z: 0 };
const _pass: NodeScratch = { nodeRef: 0, flags: 0, area: 0, kind: "polygon" };
const _current: NodeScratch = { nodeRef: 0, flags: 0, area: 0, kind: "polygon" };
const _previous: NodeScratch = { nodeRef: 0, flags: 0, area: 0, kind: "polygon" };
const _next: NodeScratch = { nodeRef: 0, flags: 0, area: 0, kind: "polygon" };
const _start: Vec3Tuple = [0, 0, 0];
const _end: Vec3Tuple = [0, 0, 0];
const _point: Vec3Tuple = [0, 0, 0];
const _extents: Vec3Tuple = [0, 0, 0];
let _nearestResult: ReturnType<typeof createFindNearestPolyResult> | undefined;
let _closestResult: ReturnType<typeof createGetClosestPointOnPolyResult> | undefined;

function nodeInfo(out: NodeScratch, mesh: NavMesh, ref: number): NavcatNode {
    const node = getNodeByRef(mesh, ref);
    out.nodeRef = ref;
    out.flags = node.flags;
    out.area = node.area;
    out.kind = node.type === 0 ? "polygon" : "connection";
    return out;
}

export function createQueryFilter(options: NavcatFilter): QueryFilter {
    if (!options.pass && !options.cost && options.includeFlags === 0xffff && options.excludeFlags === 0) {
        return DEFAULT_QUERY_FILTER;
    }
    const filter = createDefaultQueryFilter();
    filter.includeFlags = options.includeFlags!;
    filter.excludeFlags = options.excludeFlags!;
    if (options.pass) {
        filter.passFilter = (ref, mesh) => {
            const flags = getNodeByRef(mesh, ref).flags;
            return (flags & filter.includeFlags) !== 0 && (flags & filter.excludeFlags) === 0 && options.pass!(nodeInfo(_pass, mesh, ref));
        };
    }
    if (options.cost) {
        filter.getCost = (a, b, mesh, prev, current, next) => {
            const cost = options.cost!(
                fromNavcat(a, _from),
                fromNavcat(b, _to),
                nodeInfo(_current, mesh, current),
                prev === undefined ? null : nodeInfo(_previous, mesh, prev),
                next === undefined ? null : nodeInfo(_next, mesh, next)
            );
            if (!Number.isFinite(cost) || cost < 0) {
                throw new Error("Navcat cost must be finite and nonnegative");
            }
            return cost;
        };
    }
    return filter;
}

function extents(manager: NavcatManager, value?: Vec3): Vec3Tuple {
    if (!value) {
        return manager._halfExtentsTuple!;
    }
    validateNavcatVector(value, "half extents", true);
    _extents[0] = value.x;
    _extents[1] = value.y;
    _extents[2] = value.z;
    return _extents;
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
    if (!manager._queryFilter!.passFilter(start.nodeRef, mesh)) {
        throw new Error("Navcat location is excluded by the current filter");
    }
    return toNavcat(start.position, _start);
}

export function nearest(manager: NavcatManager, point: Vec3, halfExtents?: Vec3): NavcatNearestResult {
    return navcatQuery(manager, (mesh) => {
        const result = findNearestPoly((_nearestResult ??= createFindNearestPolyResult()), mesh, toNavcat(point, _start), extents(manager, halfExtents), manager._queryFilter!);
        return result.success ? { success: true, location: location(manager, result.nodeRef, result.position) } : { success: false };
    });
}

export function path(manager: NavcatManager, start: Vec3, end: Vec3, halfExtents?: Vec3, options?: NavcatPathOptions): NavcatPathResult {
    return navcatQuery(manager, (mesh) => {
        const result = findPath(mesh, toNavcat(start, _start), toNavcat(end, _end), extents(manager, halfExtents), manager._queryFilter!);
        return {
            success: result.success,
            complete: result.success && (result.flags & 2) !== 0,
            points: result.success ? result.path.map((p) => ({ position: fromNavcat(p.position), nodeRef: p.nodeRef, offMesh: (p.flags & 2) !== 0 })) : [],
            nodeRefs: result.success ? (result.nodePath?.path.slice() ?? []) : [],
            revision: manager._revision,
            _owner: manager,
            _search: options?.keepSearch ? (result.nodePath?.nodes ?? null) : null,
        };
    });
}

export function ray(manager: NavcatManager, start: NavcatLocation, end: Vec3): NavcatRaycastResult {
    return navcatQuery(manager, (mesh) => {
        const a = checkLocation(manager, mesh, start);
        const b = toNavcat(end, _end);
        const result = raycast(mesh, start.nodeRef, a, b, manager._queryFilter!);
        const hit = result.hitEdgeIndex >= 0 && result.t <= 1;
        const fraction = hit ? Math.max(0, Math.min(1, result.t)) : 1;
        _point[0] = a[0] + (b[0] - a[0]) * fraction;
        _point[1] = a[1];
        _point[2] = a[2] + (b[2] - a[2]) * fraction;
        const last = result.path.at(-1) ?? start.nodeRef;
        const projected = getClosestPointOnPoly((_closestResult ??= createGetClosestPointOnPolyResult()), mesh, last, _point);
        return {
            hit,
            fraction,
            position: fromNavcat(projected.success ? projected.position : _point),
            normal: hit ? fromNavcat(result.hitNormal) : { x: 0, y: 0, z: 0 },
            nodeRefs: result.path.slice(),
        };
    });
}

export function move(manager: NavcatManager, start: NavcatLocation, end: Vec3): NavcatMoveResult {
    return navcatQuery(manager, (mesh) => {
        const result = moveAlongSurface(mesh, start.nodeRef, checkLocation(manager, mesh, start), toNavcat(end, _end), manager._queryFilter!);
        return result.success ? { success: true, location: location(manager, result.nodeRef, result.position), visited: result.visited.slice() } : { success: false };
    });
}
