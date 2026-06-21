/** Opt-in bone control for skinned glTF models.
 *
 *  Call `enableBoneControl()` once (before loading skinned assets) to populate
 *  `AssetContainer.skeletons` with a {@link Skeleton} per glTF skin. You can then
 *  override any bone's local transform via the `setBone*` functions. Overrides:
 *    • are baked into the bone matrices immediately (works even with no animation), and
 *    • are re-applied every animation frame BEFORE channel evaluation — so a clip
 *      that animates the same bone overwrites the override (animation wins), while a
 *      bone the clip does not touch keeps the override.
 *  This is exactly the Babylon.js "scale a bone to 0 to hide its sub-tree" workflow.
 *
 *  Opt-in & near-zero-cost when unused: the always-fetched skeleton/animation chunk
 *  references this module only through the two null hooks in `bone-control-hooks.ts`.
 *  Until `enableBoneControl()` is imported + called, the tree-shaker folds this whole
 *  module (handle building, skin extraction, eager bake, override application) away.
 *
 *  Standalone functions, zero methods — idiomatic Lite, fully tree-shakeable. */

import { F32 } from "../engine/typed-arrays.js";
import type { Mat4 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import type { NodeRest, SkeletonBinding } from "../animation/types.js";
import type { GltfLoadCtx } from "../loader-gltf/gltf-feature.js";
import { resolveAccessor, computeNodeWorldMatrix, findParent } from "../loader-gltf/gltf-parser.js";
import { mat4Invert } from "../math/mat4-invert.js";
import { mat4Identity } from "../math/mat4-identity.js";
import { TRS_STRIDE, T_OFF, R_OFF, S_OFF, computeTopoOrder, resetTRS, computeNodeWorldMatrices, writeBoneTextures } from "./skeleton-pose.js";
import { _installBoneControl } from "./bone-control-hooks.js";

/** @internal Per-bone local-transform override. `mask` bits: 1 = translation,
 *  2 = rotation, 4 = scale. Only the masked components are applied. */
export interface BoneOverride {
    mask: number;
    tx: number;
    ty: number;
    tz: number;
    rx: number;
    ry: number;
    rz: number;
    rw: number;
    sx: number;
    sy: number;
    sz: number;
}

/** A single bone of a {@link Skeleton}. Pure data — drive it via the `setBone*`
 *  functions, addressing it through its owning `Skeleton`. */
export interface Bone {
    /** Bone (joint node) name from the glTF, or `bone_<index>` when unnamed. */
    readonly name: string;
    /** @internal glTF node index of this joint — the key into the override map. */
    readonly _nodeIndex: number;
}

/** A skinned model's skeleton — one per glTF skin, surfaced on
 *  `AssetContainer.skeletons` once {@link enableBoneControl} is called. Reach its
 *  bones via `skeleton.bones` / {@link getBoneByName}, and drive them via the
 *  `setBone*` functions. */
export interface Skeleton {
    /** Bones in glTF joint order (matches the skin's `joints` array). */
    readonly bones: readonly Bone[];
    /** @internal name → Bone lookup. */
    readonly _byName: Map<string, Bone>;
    /** @internal node-index → override. Shared with the asset's animation
     *  controllers so any playing clip honours the overrides. */
    readonly _overrides: Map<number, BoneOverride>;
    /** @internal Recompute + upload this skin's bone matrices from rest + overrides. */
    readonly _bake: () => void;
}

/** Find a bone by its (glTF joint node) name. Returns `undefined` if not present.
 *  When several joints share a name, the first in joint order is returned. */
export function getBoneByName(skeleton: Skeleton, name: string): Bone | undefined {
    return skeleton._byName.get(name);
}

function ensureOverride(skeleton: Skeleton, bone: Bone): BoneOverride {
    let o = skeleton._overrides.get(bone._nodeIndex);
    if (!o) {
        o = { mask: 0, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, rw: 1, sx: 1, sy: 1, sz: 1 };
        skeleton._overrides.set(bone._nodeIndex, o);
    }
    return o;
}

/** Override a bone's local translation, then re-bake. Ignored each frame for a
 *  bone whose translation the playing clip animates. */
export function setBonePosition(skeleton: Skeleton, bone: Bone, x: number, y: number, z: number): void {
    const o = ensureOverride(skeleton, bone);
    o.tx = x;
    o.ty = y;
    o.tz = z;
    o.mask |= 1;
    skeleton._bake();
}

/** Override a bone's local rotation (quaternion), then re-bake. Ignored each frame
 *  for a bone whose rotation the playing clip animates. */
export function setBoneRotationQuaternion(skeleton: Skeleton, bone: Bone, x: number, y: number, z: number, w: number): void {
    const o = ensureOverride(skeleton, bone);
    o.rx = x;
    o.ry = y;
    o.rz = z;
    o.rw = w;
    o.mask |= 2;
    skeleton._bake();
}

/** Override a bone's local scale, then re-bake. Ignored each frame for a bone
 *  whose scale the playing clip animates. */
export function setBoneScaling(skeleton: Skeleton, bone: Bone, x: number, y: number, z: number): void {
    const o = ensureOverride(skeleton, bone);
    o.sx = x;
    o.sy = y;
    o.sz = z;
    o.mask |= 4;
    skeleton._bake();
}

/** Show or hide the sub-tree driven by a bone, the Babylon.js way: hiding scales
 *  the bone to zero (collapsing it and its descendant bones to a point so the
 *  skinned triangles degenerate and disappear); showing clears the scale override
 *  so the bone returns to its animated / rest scale. */
export function setBoneVisible(skeleton: Skeleton, bone: Bone, visible: boolean): void {
    if (!visible) {
        setBoneScaling(skeleton, bone, 0, 0, 0);
        return;
    }
    const o = skeleton._overrides.get(bone._nodeIndex);
    if (o) {
        o.mask &= ~4;
        if (o.mask === 0) {
            skeleton._overrides.delete(bone._nodeIndex);
        }
        skeleton._bake();
    }
}

/** Remove all overrides for a bone, reverting it to animation / rest pose, then re-bake. */
export function clearBoneOverride(skeleton: Skeleton, bone: Bone): void {
    if (skeleton._overrides.delete(bone._nodeIndex)) {
        skeleton._bake();
    }
}

// ─── Opt-in wiring ───────────────────────────────────────────────────

/** Per-frame applier hook: write the masked override TRS into the working buffer
 *  (called by the animation tick after the rest reset, before channel eval). */
function applyOverridesToTRS(overrides: ReadonlyMap<number, BoneOverride>, currentTRS: Float32Array, numNodes: number): void {
    for (const [ni, o] of overrides) {
        if (ni < 0 || ni >= numNodes) {
            continue;
        }
        const off = ni * TRS_STRIDE;
        const m = o.mask;
        if (m & 1) {
            currentTRS[off + T_OFF] = o.tx;
            currentTRS[off + T_OFF + 1] = o.ty;
            currentTRS[off + T_OFF + 2] = o.tz;
        }
        if (m & 2) {
            currentTRS[off + R_OFF] = o.rx;
            currentTRS[off + R_OFF + 1] = o.ry;
            currentTRS[off + R_OFF + 2] = o.rz;
            currentTRS[off + R_OFF + 3] = o.rw;
        }
        if (m & 4) {
            currentTRS[off + S_OFF] = o.sx;
            currentTRS[off + S_OFF + 1] = o.sy;
            currentTRS[off + S_OFF + 2] = o.sz;
        }
    }
}

// ─── Self-contained skin extraction (mirrors gltf-animation, but lives here so
//     the always-fetched loader chunk carries none of it) ──────────────────────

function buildRestNodes(json: any, parentMap: Map<number, number>): NodeRest[] {
    const nodeCount = json.nodes?.length ?? 0;
    const nodes: NodeRest[] = [];
    for (let i = 0; i < nodeCount; i++) {
        const n = json.nodes[i];
        const t = n.translation ?? [0, 0, 0];
        const r = n.rotation ?? [0, 0, 0, 1];
        const s = n.scale ?? [1, 1, 1];
        nodes.push({
            parentIdx: findParent(parentMap, i),
            _matrix: n.matrix as Mat4 | undefined,
            tx: t[0],
            ty: t[1],
            tz: t[2],
            rx: r[0],
            ry: r[1],
            rz: r[2],
            rw: r[3],
            sx: s[0],
            sy: s[1],
            sz: s[2],
        });
    }
    return nodes;
}

function resolveIBMs(json: any, binChunk: DataView, skin: any): Float32Array {
    const jointCount = skin.joints.length;
    if (skin.inverseBindMatrices !== undefined) {
        const ibm = resolveAccessor(json, binChunk, skin.inverseBindMatrices);
        return new F32(ibm._data.buffer, ibm._data.byteOffset, jointCount * 16);
    }
    const out = new F32(jointCount * 16);
    for (let i = 0; i < jointCount; i++) {
        const o = i * 16;
        out[o] = out[o + 5] = out[o + 10] = out[o + 15] = 1;
    }
    return out;
}

function buildNodeToMeshIndices(json: any): Map<number, number[]> {
    const nodeCount = json.nodes?.length ?? 0;
    const map = new Map<number, number[]>();
    let gpuIdx = 0;
    for (let ni = 0; ni < nodeCount; ni++) {
        const node = json.nodes[ni];
        if (node.mesh === undefined) {
            continue;
        }
        const indices: number[] = [];
        for (let p = 0; p < json.meshes[node.mesh].primitives.length; p++) {
            indices.push(gpuIdx++);
        }
        map.set(ni, indices);
    }
    return map;
}

interface SkinGroup {
    jointNodes: number[];
    bindings: SkeletonBinding[];
}

function extractSkinGroups(json: any, binChunk: DataView, meshes: Mesh[], parentMap: Map<number, number>, worldMatrixCache: Map<number, Mat4>): SkinGroup[] {
    const nodeCount = json.nodes?.length ?? 0;
    const nodeToMeshIndices = buildNodeToMeshIndices(json);
    const groups: SkinGroup[] = [];
    for (let nodeIdx = 0; nodeIdx < nodeCount; nodeIdx++) {
        const node = json.nodes[nodeIdx];
        if (node.skin === undefined || !json.skins) {
            continue;
        }
        const meshIndices = nodeToMeshIndices.get(nodeIdx);
        if (!meshIndices) {
            continue;
        }
        const skin = json.skins[node.skin];
        const jointNodes: number[] = skin.joints;
        const inverseBindMatrices = resolveIBMs(json, binChunk, skin);
        const meshWorldMatrix = computeNodeWorldMatrix(json, nodeIdx, parentMap, worldMatrixCache);
        const invMeshWorld = mat4Invert(meshWorldMatrix) ?? mat4Identity();
        const bindings: SkeletonBinding[] = [];
        for (const mi of meshIndices) {
            const skeleton = meshes[mi]?.skeleton;
            if (!skeleton) {
                continue;
            }
            bindings.push({
                jointNodes,
                inverseBindMatrices,
                invMeshWorld,
                boneTexture: skeleton.boneTexture,
                boneCount: jointNodes.length,
                boneMatrices: skeleton.boneMatrices,
                runtimeSkeleton: skeleton,
            });
        }
        if (bindings.length > 0) {
            groups.push({ jointNodes, bindings });
        }
    }
    return groups;
}

/** Builder hook: construct a public `Skeleton` per glTF skin, each with an eager
 *  bake closure that recomputes the node hierarchy from rest + overrides and
 *  uploads that skin's bone textures (so overrides apply even with no animation). */
async function buildSkeletons(ctx: GltfLoadCtx, meshes: Mesh[], overrides: Map<number, BoneOverride>): Promise<{ skeletons?: Skeleton[] }> {
    const { _json: json, _binChunk: binChunk, _engine: engine, _parentMap: parentMap, _worldMatrixCache: worldMatrixCache } = ctx;

    const groups = extractSkinGroups(json, binChunk, meshes, parentMap, worldMatrixCache);
    if (groups.length === 0) {
        return {};
    }

    // Asset-wide rest-pose node table + topo order + eager-bake scratch, shared by
    // every skin's bake (overrides may reach across skins through the hierarchy).
    const nodes = buildRestNodes(json, parentMap);
    const numNodes = nodes.length;
    const topoOrder = computeTopoOrder(nodes);
    const currentTRS = new F32(numNodes * TRS_STRIDE);
    const localMat = new F32(numNodes * 16);
    const worldMat = new F32(numNodes * 16);
    const device = engine._device;

    // Re-bake EVERY skinned mesh of the asset on any override. The override map is
    // asset-wide, and a single glTF skin is often split across multiple meshes
    // (each with its own GPU bone texture in Lite), so we must refresh them all —
    // matching Babylon.js, where the shared skeleton updates every mesh at once.
    const allBindings: SkeletonBinding[] = groups.flatMap((g) => g.bindings);
    const bake = (): void => {
        resetTRS(nodes, numNodes, currentTRS);
        if (overrides.size > 0) {
            applyOverridesToTRS(overrides, currentTRS, numNodes);
        }
        computeNodeWorldMatrices(nodes, numNodes, topoOrder, currentTRS, localMat, worldMat);
        writeBoneTextures(device, allBindings, worldMat);
    };

    const skeletons: Skeleton[] = groups.map((g) => {
        const bones: Bone[] = [];
        const byName = new Map<string, Bone>();
        for (const ni of g.jointNodes) {
            const bone: Bone = { name: json.nodes?.[ni]?.name ?? `bone_${ni}`, _nodeIndex: ni };
            bones.push(bone);
            if (!byName.has(bone.name)) {
                byName.set(bone.name, bone);
            }
        }
        return { bones, _byName: byName, _overrides: overrides, _bake: bake };
    });

    return { skeletons };
}

/**
 * Enable bone control for skinned glTF models. Call once, before loading the
 * assets you want to control. After loading, read `container.skeletons` and drive
 * bones with {@link getBoneByName} + the `setBone*` functions.
 *
 * ```ts
 * enableBoneControl(); // ← opt-in, before loadGltf
 * const character = await loadGltf(engine, "character.glb");
 * addToScene(scene, character);
 * const skel = character.skeletons![0];
 * const head = getBoneByName(skel, "Head");
 * if (head) setBoneVisible(skel, head, false); // hide the head + everything under it
 * ```
 *
 * Process-global and idempotent. Skinned scenes that never call this are
 * unaffected (near byte-identical to a build without bone control).
 *
 * @public
 */
export function enableBoneControl(): void {
    _installBoneControl(buildSkeletons, applyOverridesToTRS);
}
