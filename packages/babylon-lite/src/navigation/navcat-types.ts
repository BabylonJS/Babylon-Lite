import type { NavMesh, SearchNodePool, QueryFilter } from "navcat";
import type * as Runtime from "./navcat-runtime.js";
import type { Vec3, Vec3Tuple } from "../math/types.js";

/** Optional, exclusively owned Navcat backend. Use standalone navigation functions. */
export interface NavcatManager {
    readonly backend: "navcat";
    /** @internal */ _mesh: NavMesh | null;
    /** @internal */ _api: typeof Runtime | null;
    /** @internal */ _filter: NavcatFilter | null;
    /** @internal */ _queryFilter: QueryFilter | null;
    /** @internal */ _halfExtents: Vec3 | null;
    /** @internal */ _halfExtentsTuple: Vec3Tuple | null;
    /** @internal */ _revision: number;
    /** @internal */ _meshVersion: number;
    /** @internal */ _disposed: boolean;
}

/** Borrowed node view, valid only during the synchronous query callback. Copy values to retain them. */
export interface NavcatNode {
    readonly nodeRef: number;
    readonly flags: number;
    readonly area: number;
    readonly kind: "polygon" | "connection";
}

/** Synchronous query callbacks receive borrowed views; copy retained values and do not reenter navigation. */
export interface NavcatFilter {
    includeFlags?: number;
    excludeFlags?: number;
    pass?: (node: Readonly<NavcatNode>) => boolean;
    /** Vector and node views are valid only during this call. Must return a finite nonnegative cost. Costs below distance inherit the SDK heuristic's limitations. */
    cost?: (from: Readonly<Vec3>, to: Readonly<Vec3>, current: Readonly<NavcatNode>, previous: Readonly<NavcatNode> | null, next: Readonly<NavcatNode> | null) => number;
}

/** Creation-time defaults; values are copied by the factory. */
export interface NavcatOptions {
    halfExtents?: Vec3;
    filter?: NavcatFilter;
}

/** A polygon location, valid only for its creating manager and graph revision. Reference 0 is valid. */
export interface NavcatLocation {
    readonly nodeRef: number;
    readonly position: Vec3;
    readonly revision: number;
    /** @internal */ readonly _owner: NavcatManager;
}

/** Nearest-polygon lookup can fail when no passing polygon is within the extents. */
export type NavcatNearestResult = { success: false } | { success: true; location: NavcatLocation };

/** Caller-owned left-handed straight-path point. */
export interface NavcatPathPoint {
    position: Vec3;
    nodeRef: number | null;
    offMesh: boolean;
}

/** Optional search-debugging retention; ordinary paths release the SDK search graph. */
export interface NavcatPathOptions {
    keepSearch?: boolean;
}

/** A successful path may be partial; check complete before treating the destination as reachable. */
export interface NavcatPathResult {
    success: boolean;
    complete: boolean;
    points: NavcatPathPoint[];
    nodeRefs: number[];
    revision: number;
    /** @internal */ _owner: NavcatManager;
    /** @internal */ _search: SearchNodePool | null;
}

/** Surface raycast snapshot; fraction is 1 and normal is zero on a miss. */
export interface NavcatRaycastResult {
    hit: boolean;
    fraction: number;
    position: Vec3;
    normal: Vec3;
    nodeRefs: number[];
}

/** Surface-constrained movement snapshot. */
export type NavcatMoveResult = { success: false } | { success: true; location: NavcatLocation; visited: number[] };

/** Explicit connection between two surface positions in Lite coordinates. */
export interface NavcatConnectionOptions {
    start: Vec3;
    end: Vec3;
    radius: number;
    bidirectional?: boolean;
    flags?: number;
    area?: number;
}

/** Owned connection identity; SDK pool ID 0 is valid. */
export interface NavcatConnection {
    readonly id: number;
    /** @internal */ readonly _owner: NavcatManager;
    /** @internal */ readonly _meshVersion: number;
    /** @internal */ readonly _sequence: number;
    /** @internal */ _removed: boolean;
}

/** Caller-owned RH/CCW triangles ready for Navcat generation. */
export interface NavcatGeometry {
    positions: Float64Array;
    indices: Uint32Array;
}

/** Physical solo-mesh settings; radius/height/climb are converted to voxel counts. */
export interface NavcatBuildOptions {
    cellSize?: number;
    cellHeight?: number;
    agentRadius?: number;
    agentHeight?: number;
    maxClimb?: number;
    maxSlope?: number;
    minRegionArea?: number;
    mergeRegionArea?: number;
    maxSimplificationError?: number;
    maxEdgeLength?: number;
    maxVerticesPerPoly?: number;
    detailSampleDistance?: number;
    detailSampleMaxError?: number;
}

/** Caller-owned CPU debug primitive in Lite coordinates. Rendering/disposal belongs to the caller. */
export interface NavcatDebugGeometry {
    kind: "triangles" | "lines" | "points";
    positions: Float32Array;
    colors: Float32Array;
    indices?: Uint32Array;
}

/** Optional mesh/link/search overlays. */
export interface NavcatDebugOptions {
    navMesh?: boolean;
    connections?: boolean;
    search?: NavcatPathResult;
}
