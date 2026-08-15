/**
 * Published opt-ins for Standard skeletal skinning and UV translation. Import
 * from the `@babylonjs/lite` root entry.
 *
 * RGBA vertex colours are enabled separately through the canonical
 * `enableStandardVertexColors()` from
 * the `@babylonjs/lite` root entry.
 */

import { _preloadStdMeshExt, _awaitStdMeshExtPreloads } from "./standard-group-builder.js";
import { _enableStandardGeometrySkeletonVelocity } from "./standard-geometry-feature-hooks.js";
import { _installStandardUvOffsetResolver } from "./standard-pipeline.js";

let _skeletonEnabled = false;
/** Enable four/eight-influence skeletal skinning for Standard meshes. */
export function enableStandardSkeleton(): void {
    if (_skeletonEnabled) {
        return;
    }
    _skeletonEnabled = true;
    _enableStandardGeometrySkeletonVelocity(() => import("./standard-geometry-skeleton-velocity.js"));
    // Eagerly preload + register the skinning ext so a skeletal mesh added AFTER the
    // initial group build (synchronous `_rebuildSingle`, which cannot import) is still
    // deformed. Registration is global + durable; the group builder awaits it as a
    // backstop before the first frame. See `_preloadStdMeshExt`.
    void _preloadStdMeshExt(() => import("./fragments/std-skeleton-fragment.js"), "stdSkeletonExt");
}

/** Resolve once the skinning ext enabled by {@link enableStandardSkeleton} (and any other
 *  preloaded Standard mesh-feature ext) has been registered. Await this after calling
 *  `enableStandardSkeleton()` and BEFORE adding a skinned mesh to the scene when the mesh is
 *  loaded after the first frame — otherwise the synchronous rebuild path may build its variant
 *  before the ext import resolves and the mesh renders frozen at bind pose. */
export function whenStandardMeshFeaturesReady(): Promise<void> {
    return _awaitStdMeshExtPreloads();
}

let _uvOffsetEnabled = false;
/** Enable `StandardMaterialProps.uvOffset` reads. Missing offsets remain [0, 0]. */
export function enableStandardUvOffset(): void {
    if (_uvOffsetEnabled) {
        return;
    }
    _uvOffsetEnabled = true;
    _installStandardUvOffsetResolver((material) => material.uvOffset ?? null);
}
