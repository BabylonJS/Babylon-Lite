import type { Vec3 } from "../math/types.js";
import type { NavcatManager, NavcatLocation, NavcatNearestResult, NavcatPathOptions, NavcatPathResult, NavcatRaycastResult, NavcatMoveResult } from "./navcat-types.js";
import { navcatMesh } from "./navcat-state.js";

/** Find a passing polygon within axis-aligned half extents in Lite coordinates. */
export function findNavcatNearestPoly(manager: NavcatManager, point: Vec3, halfExtents?: Vec3): NavcatNearestResult {
    navcatMesh(manager);
    return manager._api!.nearest(manager, point, halfExtents);
}

/** Find a complete or partial straight path. Search debugging is opt-in through keepSearch. */
export function findNavcatPath(manager: NavcatManager, start: Vec3, end: Vec3, halfExtents?: Vec3, options?: NavcatPathOptions): NavcatPathResult {
    navcatMesh(manager);
    return manager._api!.path(manager, start, end, halfExtents, options);
}

/** Cast across the polygon surface. Destination Y does not affect traversal. */
export function raycastNavcat(manager: NavcatManager, start: NavcatLocation, end: Vec3): NavcatRaycastResult {
    navcatMesh(manager);
    return manager._api!.ray(manager, start, end);
}

/** Constrain movement to the surface and return a new location. */
export function moveAlongNavcatSurface(manager: NavcatManager, start: NavcatLocation, end: Vec3): NavcatMoveResult {
    navcatMesh(manager);
    return manager._api!.move(manager, start, end);
}
