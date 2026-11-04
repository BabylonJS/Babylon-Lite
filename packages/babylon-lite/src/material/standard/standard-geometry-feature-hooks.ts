/** Lazy Standard geometry factories installed only by published enablers. */

let _skeletonVelocityLoader: (() => Promise<typeof import("./standard-geometry-skeleton-velocity.js")>) | null = null;

/** @internal Install skeletal geometry velocity with the Standard skeleton opt-in. */
export function _enableStandardGeometrySkeletonVelocity(loader: () => Promise<typeof import("./standard-geometry-skeleton-velocity.js")>): void {
    _skeletonVelocityLoader = loader;
}

/** @internal Resolve the loader without allocating at import time. */
export function _getStandardGeometrySkeletonVelocityLoader(): (() => Promise<typeof import("./standard-geometry-skeleton-velocity.js")>) | null {
    return _skeletonVelocityLoader;
}
