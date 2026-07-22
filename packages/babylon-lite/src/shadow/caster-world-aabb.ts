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
 *  Deriving the LOCAL AABB from the raw CPU positions (cached, recomputed only
 *  when the geometry changes) and folding its 8 corners through the mesh world
 *  matrix each call yields a correct world AABB for both conventions in O(1) per
 *  refit, so all directional/cascaded generators share this helper.
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
import type { Mat4 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";

const DEFAULT_MIN: [number, number, number] = [-0.5, -0.5, -0.5];
const DEFAULT_MAX: [number, number, number] = [0.5, 0.5, 0.5];

// Scratch buffer holding the 8 bound corners (xyz each) for the fallback path,
// reused across calls so the rare no-CPU-positions mesh costs zero allocation.
const _corners = new F32(24);

// Per-mesh LOCAL-space AABB cache. Computing the tight local box is O(vertexCount);
// caching it lets a moving caster refit each frame by folding only the 8 box corners
// through the world matrix — O(1) — instead of rescanning every vertex. The entry is
// invalidated whenever the geometry is committed anew: every commit path
// (updateMeshGeometry / resizeMeshGeometry / createMeshFromData / loaders) reassigns
// both `_cpuPositions` and fresh `boundMin`/`boundMax` arrays, so comparing those three
// references also catches an in-place vertex edit re-submitted through the SAME
// positions array (a reference-only key would miss that). Lazy-initialized per GUIDANCE
// (no module-level WeakMap allocation).
let _localAabbCache: WeakMap<Mesh, { positions: Float32Array; boundMin: unknown; boundMax: unknown; local: Aabb }> | null = null;

/** Local-space AABB of a caster's CPU positions, cached and recomputed only when the
 *  mesh's geometry changes (positions array or its `boundMin`/`boundMax` token).
 *  Returns `null` for empty/degenerate geometry. */
function localCasterAabb(mesh: Mesh, positions: Float32Array): Aabb | null {
    const cache = (_localAabbCache ??= new WeakMap<Mesh, { positions: Float32Array; boundMin: unknown; boundMax: unknown; local: Aabb }>());
    let entry = cache.get(mesh);
    if (!entry || entry.positions !== positions || entry.boundMin !== mesh.boundMin || entry.boundMax !== mesh.boundMax) {
        const local = computeAabb(positions);
        if (!Number.isFinite(local[0][0])) {
            return null;
        }
        entry = { positions, boundMin: mesh.boundMin, boundMax: mesh.boundMax, local };
        cache.set(mesh, entry);
    }
    return entry.local;
}

/** Fold a local-space AABB through the world matrix by transforming its 8 corners into
 *  the shared scratch buffer — a conservative world AABB in O(1). */
function worldAabbFromLocalBounds(bmin: readonly number[], bmax: readonly number[], world: Mat4): Aabb {
    for (let k = 0; k < 8; k++) {
        const o = k * 3;
        _corners[o] = k & 1 ? bmax[0]! : bmin[0]!;
        _corners[o + 1] = k & 2 ? bmax[1]! : bmin[1]!;
        _corners[o + 2] = k & 4 ? bmax[2]! : bmin[2]!;
    }
    return computeAabb(_corners, world);
}

// Optional bounds implementations are installed by the shadow scheduler's async preload.
// Keeping them behind that boundary leaves this synchronous fitting helper side-effect free
// and prevents static-caster shadow scenes from fetching deformable or thin-instance math.
let _deformedCasterAabb: ((mesh: Mesh) => Aabb | null) | null = null;
let _morphCasterLocalAabb: ((mesh: Mesh) => Aabb | null) | null = null;
let _thinCasterAabb: ((mesh: Mesh, deformedLocal: Aabb | null | undefined) => Aabb | null) | null = null;
// Shadow-map dirty checks include this epoch so installing an optional implementation
// invalidates any map fitted before that implementation became available.
let _casterBoundsVersion = 0;

/** @internal Local caster bounds shared with optional bounds implementations. */
export const _localCasterAabb = localCasterAabb;

/** @internal Install the lazily loaded deformable bounds implementation. */
export function _installDeformedCasterAabb(deformed: (mesh: Mesh) => Aabb | null, morphLocal: (mesh: Mesh) => Aabb | null): void {
    _deformedCasterAabb = deformed;
    _morphCasterLocalAabb = morphLocal;
    _casterBoundsVersion++;
}

/** @internal Install the lazily loaded thin-instance bounds implementation. */
export function _installThinCasterAabb(thin: (mesh: Mesh, deformedLocal: Aabb | null | undefined) => Aabb | null): void {
    _thinCasterAabb = thin;
    _casterBoundsVersion++;
}

/** Version of lazily-installed caster-bounds implementations. */
export function casterBoundsVersion(): number {
    return _casterBoundsVersion;
}

/** World-space AABB of a shadow caster, or `null` when it has no usable geometry.
 *
 *  When the deformable path is enabled, skinned and
 *  morph-only casters return their current posed bounds. Thin-instanced casters union
 *  the prototype's local bounds across every active instance transform. Static casters
 *  prefer the mesh's local AABB (derived once from the CPU position mirror
 *  and cached), folding its 8 corners through the world matrix each call — correct for
 *  both local- and world-authored bounds and O(1) per refit. Falls back to transforming
 *  the stored bound corners for the rare mesh that has no CPU positions; that path
 *  assumes local bounds, preserving the historical behavior for procedural-style
 *  casters. */
export function casterWorldAabb(mesh: Mesh): Aabb | null {
    if (mesh.thinInstances && mesh.thinInstances.count > 0) {
        if (!_thinCasterAabb) {
            return null;
        }
        if (mesh.morphTargets && !_morphCasterLocalAabb) {
            return null;
        }
        // The optional argument is intentionally tri-state: undefined means static
        // prototype bounds, an AABB means posed morph bounds, and null means the
        // deformable prototype has no usable geometry and must not fall back to static.
        return _thinCasterAabb(mesh, mesh.morphTargets ? _morphCasterLocalAabb?.(mesh) : undefined);
    }
    const deformable = (mesh.skeleton && mesh.skeleton.weights && mesh.skeleton.boneMatrices) || mesh.morphTargets;
    if (deformable && !_deformedCasterAabb) {
        return null;
    }
    const deformed = _deformedCasterAabb?.(mesh);
    if (deformed) {
        return deformed;
    }
    const positions = mesh._cpuPositions;
    if (positions && positions.length >= 3) {
        const local = localCasterAabb(mesh, positions);
        if (local) {
            return worldAabbFromLocalBounds(local[0], local[1], mesh.worldMatrix);
        }
    }
    const bmin = mesh.boundMin ?? DEFAULT_MIN;
    const bmax = mesh.boundMax ?? DEFAULT_MAX;
    const aabb = worldAabbFromLocalBounds(bmin, bmax, mesh.worldMatrix);
    return Number.isFinite(aabb[0][0]) ? aabb : null;
}
