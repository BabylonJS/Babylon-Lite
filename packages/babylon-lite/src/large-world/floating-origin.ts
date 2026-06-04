/** Floating-origin (Large World Rendering) runtime.
 *
 *  This module is dynamically imported by `createEngine` ONLY when the engine
 *  is created with `useFloatingOrigin: true`. Non-LWR engines never reference
 *  it statically — tree-shakers drop it entirely from non-LWR bundles.
 *
 *  Floating-origin offset is the active camera's world position. Each LWR-on
 *  consumer derives the offset directly from `scene.camera.worldMatrix` at
 *  the moment of use (mesh-world pack, view matrix, eye-position uniform).
 *  There is no scene-side mirror state — the previous architecture had
 *  `scene._floatingOriginOffset`/`_floatingOriginVersion`/`_eyePosition`
 *  fields kept in sync by a per-frame `updateFloatingOriginOffset` call,
 *  which was net cost without value (now ~200 bytes lighter, no per-frame
 *  copy work). Invalidation of mesh UBOs (which bake the offset in) happens
 *  via the camera's worldMatrixVersion via `wrapRenderableForFO`. */

import type { Vec3 } from "../math/types.js";
import type { SceneContext } from "../scene/scene-core.js";

/** Read the current floating-origin offset from a scene as a `Vec3`. The
 *  offset is the active camera's world position. Returns the zero vector
 *  when no camera is set (typical headless/precompute case). For non-LWR
 *  engines this module is not imported, so the function is unreachable. */
export function getFloatingOriginOffset(scene: SceneContext): Vec3 {
    const cam = scene.camera;
    if (!cam) {
        return { x: 0, y: 0, z: 0 };
    }
    const w = cam.worldMatrix;
    return { x: w[12]!, y: w[13]!, z: w[14]! };
}

/** Wrap a renderable's bare update closure with FO-version awareness.
 *
 *  Each renderable's `update` re-uploads the mesh UBO when its tracked inputs
 *  change (worldMatrix, lights count, etc.). The mesh UBO ALSO depends on the
 *  active camera's world position (which the packer subtracts from world
 *  translations), but renderables in non-LWR scenes have no reason to know
 *  about FO. Rather than inline a `camVer !== _lastCameraVersion` check into
 *  every renderable closure, the camera-version check lives here and is
 *  wrapped around the renderable's update only when the engine has FO on.
 *
 *  How it works: the wrapper tracks `_lastCameraVersion` locally. Each frame,
 *  if the active camera's `worldMatrixVersion` differs, it calls
 *  `invalidate()` — which resets the renderable's `_lastWorldVersion` to -1,
 *  forcing the inner update's "worldMatrix changed" branch to fire and
 *  re-pack with the new offset. Then the inner update runs as normal.
 *
 *  This module is dynamic-imported only when `useFloatingOrigin: true`, so
 *  non-LWR engines leave `engine._wrapRenderableForFO` undefined and
 *  renderables fall through to their bare update with zero wrapper overhead. */
export function wrapRenderableForFO(inner: () => void, scene: SceneContext, invalidate: () => void): () => void {
    let _lastCameraVersion = -1;
    return (): void => {
        const cv = scene.camera ? scene.camera.worldMatrixVersion : -1;
        if (cv !== _lastCameraVersion) {
            invalidate();
            _lastCameraVersion = cv;
        }
        inner();
    };
}
