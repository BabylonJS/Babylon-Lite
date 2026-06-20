/** Skeletal-pose bake primitives for the opt-in bone-control eager bake.
 *
 *  Mirrors the per-frame math the animation tick (skeleton-updater.ts) runs, but
 *  lives in the bone-control chunk so the always-fetched tick stays byte-identical
 *  to a build without bone control. Only imported by bone-control.ts. */

import { F32, I32, U8 } from "../engine/typed-arrays.js";
import type { NodeRest, SkeletonBinding } from "../animation/types.js";
import { mat4ComposeInto } from "../math/mat4-compose-into.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import type { Mat4Storage } from "../math/types.js";

/** TRS layout per node: 12 floats — [0..2] translation, [3..6] rotation (xyzw), [7..9] scale. */
export const TRS_STRIDE = 12;
export const T_OFF = 0;
export const R_OFF = 3;
export const S_OFF = 7;

// RH→LH root transform (same as load-gltf.ts / skeleton-updater.ts): diag(-1, 1, 1, 1)
// prettier-ignore
const RH_TO_LH = new F32([-1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1]);

// Scratch 4x4 reused during bone-matrix composition.
const _boneTmp = new F32(16);

/** Compute topological order so parents are processed before children. */
export function computeTopoOrder(nodes: readonly { readonly parentIdx: number }[]): Int32Array {
    const n = nodes.length;
    const order = new I32(n);
    const visited = new U8(n);
    let cursor = 0;
    function visit(idx: number): void {
        if (visited[idx]!) {
            return;
        }
        visited[idx] = 1;
        const p = nodes[idx]!.parentIdx;
        if (p >= 0) {
            visit(p);
        }
        order[cursor++] = idx;
    }
    for (let i = 0; i < n; i++) {
        visit(i);
    }
    return order;
}

/** Reset every node's working TRS to its rest pose. */
export function resetTRS(nodes: readonly NodeRest[], numNodes: number, currentTRS: Float32Array): void {
    for (let i = 0; i < numNodes; i++) {
        const n = nodes[i]!;
        const off = i * TRS_STRIDE;
        currentTRS[off + T_OFF] = n.tx;
        currentTRS[off + T_OFF + 1] = n.ty;
        currentTRS[off + T_OFF + 2] = n.tz;
        currentTRS[off + R_OFF] = n.rx;
        currentTRS[off + R_OFF + 1] = n.ry;
        currentTRS[off + R_OFF + 2] = n.rz;
        currentTRS[off + R_OFF + 3] = n.rw;
        currentTRS[off + S_OFF] = n.sx;
        currentTRS[off + S_OFF + 1] = n.sy;
        currentTRS[off + S_OFF + 2] = n.sz;
    }
}

/** Compose local matrices from `currentTRS` (or a node's fixed `_matrix`) and
 *  multiply each into world space in topological order. */
export function computeNodeWorldMatrices(
    nodes: readonly NodeRest[],
    numNodes: number,
    topoOrder: Int32Array,
    currentTRS: Float32Array,
    localMat: Float32Array,
    worldMat: Float32Array
): void {
    for (let idx = 0; idx < numNodes; idx++) {
        const nodeIdx = topoOrder[idx]!;
        const node = nodes[nodeIdx]!;
        const off = nodeIdx * TRS_STRIDE;
        if (node._matrix) {
            localMat.set(node._matrix, nodeIdx * 16);
        } else {
            mat4ComposeInto(
                localMat,
                nodeIdx * 16,
                currentTRS[off + T_OFF]!,
                currentTRS[off + T_OFF + 1]!,
                currentTRS[off + T_OFF + 2]!,
                currentTRS[off + R_OFF]!,
                currentTRS[off + R_OFF + 1]!,
                currentTRS[off + R_OFF + 2]!,
                currentTRS[off + R_OFF + 3]!,
                currentTRS[off + S_OFF]!,
                currentTRS[off + S_OFF + 1]!,
                currentTRS[off + S_OFF + 2]!
            );
        }
        const parentIdx = node.parentIdx;
        if (parentIdx >= 0) {
            mat4MultiplyInto(worldMat, nodeIdx * 16, worldMat, parentIdx * 16, localMat, nodeIdx * 16);
        } else {
            mat4MultiplyInto(worldMat, nodeIdx * 16, RH_TO_LH, 0, localMat, nodeIdx * 16);
        }
    }
}

/** Compute each skeleton's bone matrices (`invMeshWorld · jointWorld · IBM`) and
 *  upload them to the bone textures. */
export function writeBoneTextures(device: GPUDevice, skeletons: readonly SkeletonBinding[], worldMat: Float32Array): void {
    for (let si = 0; si < skeletons.length; si++) {
        const skel = skeletons[si]!;
        const boneData = skel.boneMatrices;
        for (let bi = 0; bi < skel.boneCount; bi++) {
            const jointIdx = skel.jointNodes[bi]!;
            const ibmOff = bi * 16;
            mat4MultiplyInto(_boneTmp, 0, skel.invMeshWorld as unknown as Mat4Storage, 0, worldMat, jointIdx * 16);
            mat4MultiplyInto(boneData, bi * 16, _boneTmp, 0, skel.inverseBindMatrices, ibmOff);
        }
        const texWidth = skel.boneCount * 4;
        device.queue.writeTexture(
            { texture: skel.runtimeSkeleton?.boneTexture ?? skel.boneTexture },
            boneData.buffer,
            { bytesPerRow: texWidth * 16 },
            { width: texWidth, height: 1 }
        );
    }
}
