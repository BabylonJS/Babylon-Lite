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
 *  conventions, so all directional/cascaded generators share this helper.
 *
 *  A skinned caster's world matrix stays fixed while the skeleton moves its
 *  vertices, so its bind-pose bounds would leave the frustum stranded when the
 *  mesh sweeps across the scene. Such casters instead use their current posed
 *  bounds (per-bone bind-space corners folded through the live bone matrices),
 *  loaded lazily from `skinned-caster-aabb` so static-caster scenes never bundle
 *  that math. So the frustum follows the animation. */

import { F32 } from "../engine/typed-arrays.js";
import { computeAabb } from "../math/compute-aabb.js";
import type { Aabb } from "../math/aabb.js";
import type { Mesh } from "../mesh/mesh.js";

const DEFAULT_MIN: [number, number, number] = [-0.5, -0.5, -0.5];
const DEFAULT_MAX: [number, number, number] = [0.5, 0.5, 0.5];

// Scratch buffer holding the 8 bound corners (xyz each) for the fallback path,
// reused across calls so the rare no-CPU-positions mesh costs zero allocation.
const _corners = new F32(24);

// Lazily-resolved skinned-AABB function. The per-bone corner + morph math it needs
// lives in `skinned-caster-aabb` (which pulls in `aabb-corners`); splitting it behind
// a dynamic import keeps that ~0.8 KB out of static-caster shadow bundles entirely —
// they never encounter a skinned caster, so `import()` never fires.
let _skinnedCasterAabb: ((mesh: Mesh) => Aabb | null) | null = null;
let _skinnedLoad: Promise<void> | null = null;

/** Enable the posed skinned-caster AABB path when any caster is skinned, otherwise a
 *  resolved no-op. Idempotent and awaitable: the returned promise resolves once the
 *  `import("./skinned-caster-aabb.js")` chunk is fetched and its function installed.
 *
 *  Driven from the async shadow preload (see `shadow-task._preload`), which awaits it
 *  before the first shadow frame, so a skinned caster's frustum tracks its posed
 *  geometry from frame one without `casterWorldAabb` ever touching the dynamic import
 *  on the hot path. Static-caster scenes never call it, so the chunk is never fetched.
 *  The skeleton check lives here (rather than in the filter-agnostic scheduler) so all
 *  skinned-caster knowledge stays in one module. */
export function enableSkinnedCasterAabb(casterMeshes: readonly Mesh[]): Promise<void> {
    for (const mesh of casterMeshes) {
        const skeleton = mesh.skeleton;
        if (skeleton && skeleton.weights && skeleton.boneMatrices) {
            _skinnedLoad ??= import("./skinned-caster-aabb.js").then((mod) => {
                _skinnedCasterAabb = mod.skinnedCasterAabb;
            });
            return _skinnedLoad;
        }
    }
    return Promise.resolve();
}

/** World-space AABB of a shadow caster, or `null` when it has no usable geometry.
 *
 *  When the skinned path is enabled (see `enableSkinnedCasterAabb`), a skinned caster
 *  returns its current posed bounds (per-bone corners folded through the live bone
 *  matrices) so the frustum follows a mesh the skeleton sweeps across the scene; the
 *  installed function returns `null` for non-skinned meshes, so static casters fall
 *  through. Prefers the CPU position mirror folded through the world matrix (correct
 *  for both local- and world-authored bounds). Falls back to transforming the stored
 *  bound corners by the world matrix for the rare mesh that has no CPU positions; that
 *  path assumes local bounds, preserving the historical behavior for procedural-style
 *  casters. */
export function casterWorldAabb(mesh: Mesh): Aabb | null {
    const skinned = _skinnedCasterAabb?.(mesh);
    if (skinned) {
        return skinned;
    }
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
