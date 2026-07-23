/** Shared world-space AABB computation for shadow-caster meshes.
 *
 *  Public `boundMin`/`boundMax` values retain their historical mixed conventions:
 *  procedural meshes store local bounds while glTF stores world bounds for camera
 *  framing. Supported creation and update paths therefore also retain one
 *  authoritative LOCAL `_localBounds` value for shadow fitting.
 *
 *  Transforming that local box's center/extents through the mesh world matrix
 *  yields a correct world AABB in O(1) per refit without double-transforming
 *  loader bounds.
 *
 *  A skinned caster's world matrix stays fixed while the skeleton moves its
 *  vertices, so its bind-pose bounds would leave the frustum stranded when the
 *  mesh sweeps across the scene. Such casters instead use their current posed
 *  bounds (per-bone bind-space corners folded through the live bone matrices),
 *  loaded lazily from `skinned-caster-aabb` so static and morph-only scenes never
 *  bundle that math. Morph bounds are independently loaded from
 *  `morph-caster-aabb`, so each scene fetches only its deformation type. */

import type { Aabb } from "../math/aabb.js";
import type { Mat4 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";

/** Fold a local-space AABB through an affine world matrix using center/extents.
 *  Absolute basis coefficients produce the exact axis-aligned world extents. */
function worldAabbFromLocalBounds(bmin: readonly number[], bmax: readonly number[], world: Mat4): Aabb {
    const min: [number, number, number] = [0, 0, 0];
    const max: [number, number, number] = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
        let center = world[12 + axis]!;
        let extent = 0;
        for (let localAxis = 0; localAxis < 3; localAxis++) {
            const basis = world[localAxis * 4 + axis]!;
            center += basis * (bmin[localAxis]! + bmax[localAxis]!) * 0.5;
            extent += Math.abs(basis) * (bmax[localAxis]! - bmin[localAxis]!) * 0.5;
        }
        min[axis] = center - extent;
        max[axis] = center + extent;
    }
    return [min, max];
}

// Optional bounds implementations are installed by the shadow scheduler's async preload.
// Keeping them behind that boundary leaves this synchronous fitting helper side-effect free
// and prevents static-caster shadow scenes from fetching deformable or thin-instance math.
type CasterAabbRegistry = [
    skinned: ((mesh: Mesh) => Aabb | null) | undefined,
    morphLocal: ((mesh: Mesh) => Aabb | null) | undefined,
    thin: ((mesh: Mesh, deformedLocal: Aabb | null | undefined) => Aabb | null) | undefined,
];

/** @internal Lazily installed caster-bounds implementations. */
export const _casterAabb: CasterAabbRegistry = [undefined, undefined, undefined];

/** Whether every optional bounds implementation and deformation tracker needed by this caster is installed. */
export function casterBoundsReady(mesh: Mesh): boolean {
    const skeleton = mesh.skeleton;
    return (
        (!skeleton || !skeleton.weights || !skeleton.boneMatrices || skeleton._shadowVersion !== undefined) &&
        (!mesh.morphTargets || mesh.morphTargets._shadowVersion !== undefined) &&
        (!mesh.thinInstances || (!!_casterAabb[2] && !!mesh.thinInstances._shadowBoundsReady))
    );
}

/** World-space AABB of a shadow caster, or `null` when it has no usable geometry.
 *
 *  When the corresponding optional path is enabled, skinned and morph-only casters
 *  return their current posed bounds. Thin-instanced casters union
 *  the prototype's local bounds across every active instance transform. Static casters
 *  transform the authoritative local box through the world matrix in O(1), falling
 *  back to stored bounds only for manually assembled meshes. */
export function casterWorldAabb(mesh: Mesh): Aabb | null {
    if (mesh.thinInstances && mesh.thinInstances.count > 0) {
        // The optional argument is intentionally tri-state: undefined means static
        // prototype bounds, an AABB means posed morph bounds, and null means the
        // deformable prototype has no usable geometry and must not fall back to static.
        return _casterAabb[2]?.(mesh, mesh.morphTargets ? (_casterAabb[1]?.(mesh) ?? null) : undefined) ?? null;
    }
    const skeleton = mesh.skeleton;
    if (skeleton && skeleton.weights && skeleton.boneMatrices) {
        return _casterAabb[0]?.(mesh) ?? null;
    }
    const local = mesh.morphTargets ? _casterAabb[1]?.(mesh) : (mesh._localBounds ?? (mesh.boundMin && mesh.boundMax ? [mesh.boundMin, mesh.boundMax] : null));
    return local ? worldAabbFromLocalBounds(local[0], local[1], mesh.worldMatrix) : null;
}
