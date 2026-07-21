// Skinned shadow-caster world-AABB, split into its own module so it is only
// fetched when a scene actually has a skinned caster. `caster-world-aabb`
// `import()`s this lazily; static-caster shadow scenes never load it (and never
// pay for the per-bone corner + morph math it pulls in from `aabb-corners`).

import { F32 } from "../engine/typed-arrays.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import type { Mat4Storage } from "../math/types.js";
import type { Aabb } from "../math/aabb.js";
import type { Mesh } from "../mesh/mesh.js";
import type { BoneCornerBox } from "../mesh/aabb-corners.js";
import { buildSkinnedBoneCorners, growCornersByMatrix } from "../mesh/aabb-corners.js";

// Per-bone bind-space corner boxes for skinned casters, built once from static bind
// data (positions/joints/weights/morph deltas never change) and reused every frame.
// `null` marks a mesh with a skeleton but no usable geometry so it is not rebuilt.
// Lazy-initialized per GUIDANCE (no module-level WeakMap allocation).
let _boneCornerCache: WeakMap<Mesh, BoneCornerBox[] | null> | null = null;

// Scratch skinning matrix (`worldMatrix · boneMatrices[bone]`), reused per call.
const _skinMatrix = new F32(16);

/** World-space AABB of a skinned caster at its current pose, or `null` when the
 *  mesh is not skinned / has no usable geometry. Each influencing bone's bind-space
 *  corner box (cached) is folded through `worldMatrix · boneMatrices[bone]` — the
 *  exact skinning transform the depth pass rasterizes — so the frustum tracks the
 *  posed geometry as the skeleton animates or sweeps the mesh across the scene. */
export function skinnedCasterAabb(mesh: Mesh): Aabb | null {
    const skeleton = mesh.skeleton;
    if (!skeleton || !skeleton.weights || !skeleton.boneMatrices) {
        return null;
    }
    const cache = (_boneCornerCache ??= new WeakMap<Mesh, BoneCornerBox[] | null>());
    let boneBoxes = cache.get(mesh);
    if (boneBoxes === undefined) {
        boneBoxes = buildSkinnedBoneCorners(mesh);
        cache.set(mesh, boneBoxes);
    }
    if (!boneBoxes) {
        return null;
    }
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const world = mesh.worldMatrix as unknown as Mat4Storage;
    const boneMatrices = skeleton.boneMatrices;
    for (const box of boneBoxes) {
        mat4MultiplyInto(_skinMatrix, 0, world, 0, boneMatrices, box.boneIndex * 16);
        growCornersByMatrix(box.corners, _skinMatrix, min, max);
    }
    return Number.isFinite(min[0]) ? [min, max] : null;
}
