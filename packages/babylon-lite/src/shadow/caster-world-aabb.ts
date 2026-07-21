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
 *  through. Prefers the mesh's local AABB (derived once from the CPU position mirror
 *  and cached), folding its 8 corners through the world matrix each call — correct for
 *  both local- and world-authored bounds and O(1) per refit. Falls back to transforming
 *  the stored bound corners for the rare mesh that has no CPU positions; that path
 *  assumes local bounds, preserving the historical behavior for procedural-style
 *  casters. */
export function casterWorldAabb(mesh: Mesh): Aabb | null {
    const skinned = _skinnedCasterAabb?.(mesh);
    if (skinned) {
        return skinned;
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
