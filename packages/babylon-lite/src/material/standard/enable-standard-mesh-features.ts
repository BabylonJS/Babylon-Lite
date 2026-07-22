/**
 * Published opt-ins for Standard skeletal skinning and UV translation. Import
 * from `@babylonjs/lite/material/standard/enable-standard-mesh-features`.
 *
 * RGBA vertex colours are enabled separately through the canonical
 * `enableStandardVertexColors()` from
 * `@babylonjs/lite/material/standard/enable-standard-vertex-colors`.
 */

import { _preloadStdMeshExt } from "./standard-group-builder.js";
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
    _preloadStdMeshExt(() => import("./fragments/std-skeleton-fragment.js"), "stdSkeletonExt");
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
