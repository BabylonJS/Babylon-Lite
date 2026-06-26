/**
 * Opt-in enablers for the Standard material's deform/vertex mesh features (vertex color, skeleton)
 * and UV offset. Each registers a dispatcher into the Standard group-builder's module-local
 * `_stdMeshExtDispatch` registry so the group-builder dynamically loads the matching fragment chunk
 * when a mesh in the group has the feature (UV offset toggles a pipeline fold flag instead).
 *
 * This is the **net-neutral fold seam** (same pattern as `enableMaterialStencil`): a scene that
 * never calls one of these never imports this module, so the group-builder's dispatch registry and
 * the per-feature shader chunks fold completely out of the bundle. Loaders (the FBX loader) and
 * in-code scenes that build such meshes call the matching `enableStandard*()`, so only those scenes
 * pay for them; plain Standard scenes stay byte-identical to upstream.
 *
 * Each enabler is idempotent (registers its dispatcher at most once per session).
 *
 * NOTE: morph targets are integrated automatically by master's `_computeMeshFeatures` path (no
 * opt-in needed), and explicit-tangent normal mapping is not yet ported — so no enabler for those.
 */

import type { Mesh } from "../../mesh/mesh.js";
import { _registerStdMeshExtDispatch } from "./standard-group-builder.js";
import { _installStandardUvOffset } from "./standard-pipeline.js";

let _vColorEnabled = false;
/** Enable Standard per-vertex color (RGB). Called by loaders/scenes that build vertex-colored meshes. */
export function enableStandardVertexColor(): void {
    if (_vColorEnabled) {
        return;
    }
    _vColorEnabled = true;
    _registerStdMeshExtDispatch([(m: Mesh) => !!m._gpu?.colorBuffer, () => import("./fragments/std-vertex-color-fragment.js"), "stdVertexColorExt"]);
}

let _skeletonEnabled = false;
/** Enable Standard skeletal skinning. Called by loaders/scenes that build skinned meshes. */
export function enableStandardSkeleton(): void {
    if (_skeletonEnabled) {
        return;
    }
    _skeletonEnabled = true;
    _registerStdMeshExtDispatch([(m: Mesh) => !!m.skeleton, () => import("./fragments/std-skeleton-fragment.js"), "stdSkeletonExt"]);
}

let _uvOffsetEnabled = false;
/** Enable Standard UV offset (`material.uvOffset`). Called by loaders/scenes that set a non-zero UV
 *  translation (the FBX loader, from `uvTranslation`). Without this, the pipeline's UV-offset reads
 *  fold to a constant 0 so non-offset scenes stay byte-identical. */
export function enableStandardUvOffset(): void {
    if (_uvOffsetEnabled) {
        return;
    }
    _uvOffsetEnabled = true;
    _installStandardUvOffset();
}
