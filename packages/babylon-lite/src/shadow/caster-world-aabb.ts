/** Shared world-space AABB computation for shadow-caster meshes.
 *
 *  Casters carry two different bounds conventions. Procedural meshes store a
 *  LOCAL `boundMin`/`boundMax` (see `mesh-factories`), while glTF meshes store a
 *  WORLD-space AABB (the loader folds the world matrix into `computeAabb`, see
 *  `load-gltf`). A shadow generator that multiplies `boundMin`/`boundMax` by the
 *  mesh world matrix therefore double-transforms glTF casters — collapsing a
 *  0.01-scaled model's ortho frustum ~100x — while using the bounds directly
 *  misplaces procedural casters that sit away from the origin.
 *
 *  Folding the raw CPU positions through the mesh world matrix — the exact
 *  transform the depth pass rasterizes — yields the correct world AABB for both
 *  conventions, so all directional/cascaded generators share this helper. */

import { F32 } from "../engine/typed-arrays.js";
import { computeAabb } from "../math/compute-aabb.js";
import type { Aabb } from "../math/aabb.js";
import type { Mesh } from "../mesh/mesh.js";

const DEFAULT_MIN: [number, number, number] = [-0.5, -0.5, -0.5];
const DEFAULT_MAX: [number, number, number] = [0.5, 0.5, 0.5];

// Scratch buffer holding the 8 bound corners (xyz each) for the fallback path,
// reused across calls so the rare no-CPU-positions mesh costs zero allocation.
const _corners = new F32(24);

/** World-space AABB of a shadow caster, or `null` when it has no usable geometry.
 *
 *  Prefers the CPU position mirror folded through the world matrix (correct for
 *  both local- and world-authored bounds). Falls back to transforming the stored
 *  bound corners by the world matrix for the rare mesh that has no CPU positions;
 *  that path assumes local bounds, preserving the historical behavior for
 *  procedural-style casters. Both paths delegate the transform-and-fold to
 *  `computeAabb`, which is already bundled by every shadow scene. */
export function casterWorldAabb(mesh: Mesh): Aabb | null {
    const positions = mesh._cpuPositions;
    if (positions && positions.length >= 3) {
        const aabb = computeAabb(positions, mesh.worldMatrix);
        if (Number.isFinite(aabb[0][0])) {
            return aabb;
        }
    }
    const bmin = mesh.boundMin ?? DEFAULT_MIN;
    const bmax = mesh.boundMax ?? DEFAULT_MAX;
    for (let k = 0; k < 8; k++) {
        const o = k * 3;
        _corners[o] = k & 1 ? bmax[0] : bmin[0];
        _corners[o + 1] = k & 2 ? bmax[1] : bmin[1];
        _corners[o + 2] = k & 4 ? bmax[2] : bmin[2];
    }
    const aabb = computeAabb(_corners, mesh.worldMatrix);
    return Number.isFinite(aabb[0][0]) ? aabb : null;
}
