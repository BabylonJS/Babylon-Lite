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
import { MAX_LIGHTS, LIGHT_ENTRY_FLOATS } from "../light/types.js";
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
/** @internal Active-camera `worldMatrixVersion`, folded into the lights UBO
 *  version so a camera move alone forces a re-upload — the floating-origin
 *  offset is baked into every world-space light position, so the UBO is stale
 *  whenever the camera moves even if no light property changed. Returns 0 when
 *  no camera is set. Reachable only when FO is on (this module is
 *  dynamic-imported), so it stays out of non-LWR light bundles. */
export function lightFoVersion(scene: SceneContext): number {
    return scene.camera ? scene.camera.worldMatrixVersion : 0;
}

/** @internal Subtract the active-camera floating-origin offset from the
 *  positional (point = type tag 0, spot = type tag 2) light entries already
 *  laid out in the lights UBO scratch by `fillLightsData`. Direction-only
 *  entries (directional = 1, hemispheric = 3) are left untouched.
 *
 *  Precision: each positional slot is rewritten from the light's F64
 *  `worldMatrix` translation as `worldPos - cameraPos`, computed in F64 and
 *  stored once into the F32 scratch. The raw F32 world position the writer
 *  left in the slot is discarded, so the `large - large = small` cancellation
 *  happens at full F64 precision before the single F32 store — identical to an
 *  inline per-writer subtraction, but kept entirely out of non-LWR bundles
 *  (the writers stay precision-only, mirroring `pack-mat4-with-offset.ts`).
 *
 *  The light walk mirrors `fillLightsData` exactly (skip lights without
 *  `_writeLightUbo`, stop at `MAX_LIGHTS`) so `o` lines up with each written
 *  entry. Reachable only when FO is on (dynamic-imported module). */
export function applyLightFoOffset(data: Float32Array, scene: SceneContext): void {
    const cam = scene.camera;
    const w = cam?.worldMatrix;
    if (!w) {
        return;
    }
    const ox = w[12]!;
    const oy = w[13]!;
    const oz = w[14]!;
    let count = 0;
    for (const light of scene.lights) {
        if (count >= MAX_LIGHTS) {
            break;
        }
        if (!light._writeLightUbo) {
            continue;
        }
        const o = 4 + count * LIGHT_ENTRY_FLOATS; // header (4 floats) + entry offset
        const type = data[o + 3];
        if (type === 0 || type === 2) {
            const lw = light.worldMatrix;
            data[o] = lw[12]! - ox;
            data[o + 1] = lw[13]! - oy;
            data[o + 2] = lw[14]! - oz;
        }
        count++;
    }
}

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
