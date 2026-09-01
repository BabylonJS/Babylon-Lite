/** BankedFreeCamera — a FreeCamera whose look-at up vector is explicit and mutable.
 *
 *  A plain `createFreeCamera` always builds its basis against world +Y, so it can never roll. A chase
 *  camera bolted to a vehicle on a banked or inverted track needs the third basis vector to follow the
 *  vehicle instead, which is what this constructor exposes.
 *
 *  Opt-in and tree-shakable: scenes that never import `createBankedFreeCamera` keep the shared world-up
 *  path and pay nothing for it. `_createFreeCamera` in `free-camera.ts` has no notion of "banked" — it
 *  just reads `up.x/y/z` off whatever `Vec3` it is handed. All banked-only code (the mutable
 *  `ObservableVec3` up vector, its dirty wiring, and the public `upVector` property) lives entirely in
 *  this module, so the shared factory carries zero conditional branches or property-definition code for
 *  it. */

import type { Vec3 } from "../math/types.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import { _createFreeCamera, type FreeCamera } from "./free-camera.js";
import { _markWorldMatrixDirty } from "../scene/world-matrix-state.js";

/** A {@link FreeCamera} with an explicit, mutable world-space up vector. */
export interface BankedFreeCamera extends FreeCamera {
    /** World-space up vector used to build the look-at basis. Mutate it to roll the camera.
     *  Writes invalidate the camera's world matrix exactly like `position` / `target` do. */
    readonly upVector: ObservableVec3;
}

/**
 * Creates a free camera whose look-at up vector is explicit and mutable, so the camera can roll.
 *
 * The camera is otherwise identical to {@link createFreeCamera}: plain data, positioned in world space,
 * looking at `target`, left-handed. Setting `upVector` (e.g. easing it toward a vehicle's up axis) rolls
 * the view; a degenerate up (parallel to the view direction) falls back to an identity rotation, matching
 * `createFreeCamera`.
 *
 * @param position - World-space camera position.
 * @param target - World-space point the camera looks at.
 * @param up - Initial world-space up vector. Defaults to world +Y.
 * @returns Plain `BankedFreeCamera` data — the caller assigns it to `scene.camera`.
 */
export function createBankedFreeCamera(position: Vec3, target: Vec3, up: Vec3 = { x: 0, y: 1, z: 0 }): BankedFreeCamera {
    // `upVector`'s dirty callback closes over `cam`, declared just below — safe because ObservableVec3's
    // constructor writes its private fields directly and never invokes `onDirty`, so the callback can
    // only ever fire after `cam` is assigned.
    const upVector = new ObservableVec3(up.x, up.y, up.z, () => _markWorldMatrixDirty(cam));
    const cam = _createFreeCamera(position, target, upVector) as BankedFreeCamera;
    Object.defineProperty(cam, "upVector", { value: upVector, enumerable: true });
    return cam;
}
