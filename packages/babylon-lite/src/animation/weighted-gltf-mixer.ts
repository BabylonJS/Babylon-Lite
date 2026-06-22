import { F32, I32, U8 } from "../engine/typed-arrays.js";
import { tickAnimation } from "./animation-group.js";
import type { AnimationGltfMixer, AnimationGroup } from "./animation-group.js";
import { ANIMATION_GROUP_TASK_CATEGORY, getAnimationGroupOwner, getAnimationGroups } from "./animation-group-task.js";
import { setAnimationTaskCategoryHandler } from "./animation-manager.js";
import type { AnimationManager } from "./animation-manager.js";
import type { NodeRest, SkeletonBinding } from "./types.js";
import { PATH_ROTATION, PATH_SCALE, PATH_TRANSLATION } from "./types.js";
import { evaluateSampler } from "./evaluate.js";
import { mat4ComposeInto } from "../math/mat4-compose-into.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import type { Mat4Storage } from "../math/types.js";

const GLTF_CLIP = 0;
const GLTF_NODES = 1;
const GLTF_SKELETONS = 2;
const TRS_STRIDE = 12;
const T_OFF = 0;
const R_OFF = 3;
const S_OFF = 7;

// RH->LH root transform (same as skeleton-updater.ts)
// prettier-ignore
const RH_TO_LH = new F32([-1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1]);

const _boneTmp = new F32(16);

interface WeightedGltfTarget {
    readonly nodes: readonly NodeRest[];
    readonly skeletons: readonly SkeletonBinding[];
    readonly trs: Float32Array;
    readonly localMat: Float32Array;
    readonly worldMat: Float32Array;
    readonly topoOrder: Int32Array;
    readonly tWeight: Float32Array;
    readonly rWeight: Float32Array;
    readonly sWeight: Float32Array;
    active: boolean;
}

interface WeightedGltfScratch {
    readonly keys: Set<object>;
    readonly targets: Map<object, WeightedGltfTarget>;
    readonly sample: Float32Array;
    readonly reference: Float32Array;
    readonly delta: Float32Array;
}

let scratchByManager: WeakMap<AnimationManager, WeightedGltfScratch> | undefined;

/** Options for {@link setAnimationAdditive}, selecting the reference pose subtracted from an additive animation. */
export interface AnimationAdditiveOptions {
    readonly referenceFrame?: number;
    readonly referenceTime?: number;
}

/** Enable advanced animation blending for a manager. Kept opt-in so manual-only weights do not pay for skeletal mixing code. */
export function enableAnimationBlending(manager: AnimationManager): void {
    setAnimationTaskCategoryHandler(manager, ANIMATION_GROUP_TASK_CATEGORY, updateWeightedGltfAnimations);
}

/** Mark an animation group as additive. Reference defaults to frame 0, matching Babylon.js MakeAnimationAdditive. */
export function setAnimationAdditive(group: AnimationGroup, options?: AnimationAdditiveOptions): void {
    if (options?.referenceFrame !== undefined && options.referenceTime !== undefined) {
        throw new Error("Additive animation reference must use either referenceFrame or referenceTime, not both");
    }
    const referenceTime = options?.referenceTime ?? (options?.referenceFrame ?? 0) / (group.frameRate || 60);
    if (!Number.isFinite(referenceTime) || referenceTime < 0) {
        throw new Error(`Additive animation reference time must be a finite non-negative number, got ${referenceTime}`);
    }
    group._additive = { referenceTime };
    const owner = getAnimationGroupOwner(group);
    if (owner) {
        enableAnimationBlending(owner);
    }
}

function getScratch(manager: AnimationManager): WeightedGltfScratch {
    scratchByManager ??= new WeakMap();
    let scratch = scratchByManager.get(manager);
    if (!scratch) {
        scratch = {
            keys: new Set<object>(),
            targets: new Map<object, WeightedGltfTarget>(),
            sample: new F32(16),
            reference: new F32(16),
            delta: new F32(16),
        };
        scratchByManager.set(manager, scratch);
    }
    return scratch;
}

function updateWeightedGltfAnimations(manager: AnimationManager, deltaMs: number): boolean {
    const scratch = getScratch(manager);
    const keys = scratch.keys;
    keys.clear();

    const groups = getAnimationGroups(manager);
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex]!;
        const mixer = group._gltfMixer;
        if (group._stopped || !mixer || (group.weight === 1 && !group._additive)) {
            continue;
        }
        keys.add(mixer[GLTF_NODES]);
    }

    if (keys.size === 0) {
        return false;
    }

    scratch.targets.forEach(resetWeightedGltfTarget);

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex]!;
        if (group._stopped) {
            continue;
        }

        const mixer = group._gltfMixer;
        if (mixer && keys.has(mixer[GLTF_NODES])) {
            if (group._additive) {
                getTarget(scratch, mixer).active = true;
                advanceGroupTime(group, mixer, deltaMs);
            } else {
                accumulateGroup(manager, scratch, group, mixer, deltaMs);
            }
            continue;
        }

        tickAnimation(group, deltaMs, manager.engine);
    }

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex]!;
        const mixer = group._gltfMixer;
        if (!group._stopped && group._additive && mixer && keys.has(mixer[GLTF_NODES])) {
            accumulateAdditiveGroup(scratch, group, mixer);
        }
    }

    scratch.targets.forEach((target, key) => {
        if (target.active && keys.has(key)) {
            uploadTarget(manager, target);
        }
    });

    return true;
}

function resetWeightedGltfTarget(target: WeightedGltfTarget): void {
    target.active = false;
    target.tWeight.fill(0);
    target.rWeight.fill(0);
    target.sWeight.fill(0);
    resetTarget(target);
}

function getTarget(scratch: WeightedGltfScratch, mixer: AnimationGltfMixer): WeightedGltfTarget {
    const nodes = mixer[GLTF_NODES];
    let target = scratch.targets.get(nodes);
    if (!target) {
        const numNodes = nodes.length;
        target = {
            nodes,
            skeletons: mixer[GLTF_SKELETONS],
            trs: new F32(numNodes * TRS_STRIDE),
            localMat: new F32(numNodes * 16),
            worldMat: new F32(numNodes * 16),
            topoOrder: computeTopoOrder(nodes),
            tWeight: new F32(numNodes),
            rWeight: new F32(numNodes),
            sWeight: new F32(numNodes),
            active: false,
        };
        scratch.targets.set(nodes, target);
    }
    return target;
}

function resetTarget(target: WeightedGltfTarget): void {
    const { nodes, trs } = target;
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]!;
        const off = i * TRS_STRIDE;
        trs[off + T_OFF] = n.tx;
        trs[off + T_OFF + 1] = n.ty;
        trs[off + T_OFF + 2] = n.tz;
        trs[off + R_OFF] = n.rx;
        trs[off + R_OFF + 1] = n.ry;
        trs[off + R_OFF + 2] = n.rz;
        trs[off + R_OFF + 3] = n.rw;
        trs[off + S_OFF] = n.sx;
        trs[off + S_OFF + 1] = n.sy;
        trs[off + S_OFF + 2] = n.sz;
    }
}

function accumulateAdditiveGroup(scratch: WeightedGltfScratch, group: AnimationGroup, mixer: AnimationGltfMixer): void {
    const additive = group._additive;
    const weight = group.weight;
    if (!additive || weight === 0) {
        return;
    }

    const target = getTarget(scratch, mixer);
    const clip = mixer[GLTF_CLIP];
    const t = group.currentTime;
    for (let channelIndex = 0; channelIndex < clip.channels.length; channelIndex++) {
        const ch = clip.channels[channelIndex]!;
        const sampler = clip.samplers[ch.samplerIdx]!;
        const nodeIdx = ch.nodeIdx;
        const base = nodeIdx * TRS_STRIDE;
        switch (ch.path) {
            case PATH_TRANSLATION:
                evaluateSampler(sampler, t, 3, false, scratch.sample, 0);
                evaluateSampler(sampler, additive.referenceTime, 3, false, scratch.reference, 0);
                target.trs[base + T_OFF] = target.trs[base + T_OFF]! + (scratch.sample[0]! - scratch.reference[0]!) * weight;
                target.trs[base + T_OFF + 1] = target.trs[base + T_OFF + 1]! + (scratch.sample[1]! - scratch.reference[1]!) * weight;
                target.trs[base + T_OFF + 2] = target.trs[base + T_OFF + 2]! + (scratch.sample[2]! - scratch.reference[2]!) * weight;
                break;
            case PATH_SCALE:
                evaluateSampler(sampler, t, 3, false, scratch.sample, 0);
                evaluateSampler(sampler, additive.referenceTime, 3, false, scratch.reference, 0);
                target.trs[base + S_OFF] = target.trs[base + S_OFF]! + (scratch.sample[0]! - scratch.reference[0]!) * weight;
                target.trs[base + S_OFF + 1] = target.trs[base + S_OFF + 1]! + (scratch.sample[1]! - scratch.reference[1]!) * weight;
                target.trs[base + S_OFF + 2] = target.trs[base + S_OFF + 2]! + (scratch.sample[2]! - scratch.reference[2]!) * weight;
                break;
            case PATH_ROTATION:
                evaluateSampler(sampler, t, 4, true, scratch.sample, 0);
                evaluateSampler(sampler, additive.referenceTime, 4, true, scratch.reference, 0);
                quatRefInverseTimesSample(scratch.delta, scratch.reference, scratch.sample);
                applyAdditiveQuaternion(target.trs, base + R_OFF, scratch.delta, weight);
                break;
        }
    }
}

function accumulateGroup(manager: AnimationManager, scratch: WeightedGltfScratch, group: AnimationGroup, mixer: AnimationGltfMixer, deltaMs: number): void {
    if (!manager.engine) {
        throw new Error("Weighted glTF animation requires an AnimationManager engine");
    }

    const target = getTarget(scratch, mixer);
    const t = advanceGroupTime(group, mixer, deltaMs);
    const weight = group.weight;
    target.active = true;
    if (weight === 0) {
        return;
    }

    const clip = mixer[GLTF_CLIP];
    for (let channelIndex = 0; channelIndex < clip.channels.length; channelIndex++) {
        const ch = clip.channels[channelIndex]!;
        const sampler = clip.samplers[ch.samplerIdx]!;
        const nodeIdx = ch.nodeIdx;
        const base = nodeIdx * TRS_STRIDE;
        switch (ch.path) {
            case PATH_TRANSLATION:
                evaluateSampler(sampler, t, 3, false, scratch.sample, 0);
                if (target.tWeight[nodeIdx] === 0) {
                    target.trs[base + T_OFF] = 0;
                    target.trs[base + T_OFF + 1] = 0;
                    target.trs[base + T_OFF + 2] = 0;
                }
                target.trs[base + T_OFF] = target.trs[base + T_OFF]! + scratch.sample[0]! * weight;
                target.trs[base + T_OFF + 1] = target.trs[base + T_OFF + 1]! + scratch.sample[1]! * weight;
                target.trs[base + T_OFF + 2] = target.trs[base + T_OFF + 2]! + scratch.sample[2]! * weight;
                target.tWeight[nodeIdx] = target.tWeight[nodeIdx]! + weight;
                break;
            case PATH_SCALE:
                evaluateSampler(sampler, t, 3, false, scratch.sample, 0);
                if (target.sWeight[nodeIdx] === 0) {
                    target.trs[base + S_OFF] = 0;
                    target.trs[base + S_OFF + 1] = 0;
                    target.trs[base + S_OFF + 2] = 0;
                }
                target.trs[base + S_OFF] = target.trs[base + S_OFF]! + scratch.sample[0]! * weight;
                target.trs[base + S_OFF + 1] = target.trs[base + S_OFF + 1]! + scratch.sample[1]! * weight;
                target.trs[base + S_OFF + 2] = target.trs[base + S_OFF + 2]! + scratch.sample[2]! * weight;
                target.sWeight[nodeIdx] = target.sWeight[nodeIdx]! + weight;
                break;
            case PATH_ROTATION: {
                evaluateSampler(sampler, t, 4, true, scratch.sample, 0);
                if (target.rWeight[nodeIdx] === 0) {
                    target.trs[base + R_OFF] = scratch.sample[0]!;
                    target.trs[base + R_OFF + 1] = scratch.sample[1]!;
                    target.trs[base + R_OFF + 2] = scratch.sample[2]!;
                    target.trs[base + R_OFF + 3] = scratch.sample[3]!;
                    target.rWeight[nodeIdx] = weight;
                    break;
                }
                const accumulatedWeight = target.rWeight[nodeIdx]!;
                quatSlerpInto(
                    target.trs,
                    base + R_OFF,
                    target.trs[base + R_OFF]!,
                    target.trs[base + R_OFF + 1]!,
                    target.trs[base + R_OFF + 2]!,
                    target.trs[base + R_OFF + 3]!,
                    scratch.sample[0]!,
                    scratch.sample[1]!,
                    scratch.sample[2]!,
                    scratch.sample[3]!,
                    weight / (accumulatedWeight + weight)
                );
                target.rWeight[nodeIdx] = accumulatedWeight + weight;
                break;
            }
        }
    }
}

function advanceGroupTime(group: AnimationGroup, mixer: AnimationGltfMixer, deltaMs: number): number {
    const clip = mixer[GLTF_CLIP];
    const isPlaying = group.isPlaying;
    if (isPlaying) {
        group.currentTime += (deltaMs / 1000) * group.speedRatio;
    }

    if (clip.duration <= 0) {
        return 0;
    }

    if (group.loopAnimation && isPlaying) {
        group.currentTime %= clip.duration;
        if (group.currentTime < 0) {
            group.currentTime += clip.duration;
        }
    } else {
        group.currentTime = Math.min(Math.max(group.currentTime, 0), clip.duration);
    }
    return group.currentTime;
}

function uploadTarget(manager: AnimationManager, target: WeightedGltfTarget): void {
    if (!manager.engine) {
        throw new Error("Weighted glTF animation requires an AnimationManager engine");
    }
    const device = manager.engine._device;
    const { nodes, trs, localMat, worldMat } = target;

    for (let i = 0; i < nodes.length; i++) {
        const rotationWeight = target.rWeight[i]!;
        if (rotationWeight > 0 && rotationWeight < 1) {
            const off = i * TRS_STRIDE + R_OFF;
            const node = nodes[i]!;
            quatSlerpInto(trs, off, node.rx, node.ry, node.rz, node.rw, trs[off]!, trs[off + 1]!, trs[off + 2]!, trs[off + 3]!, rotationWeight);
        } else if (rotationWeight > 0) {
            normalizeQuaternionAt(trs, i * TRS_STRIDE + R_OFF);
        }
    }

    for (let idx = 0; idx < nodes.length; idx++) {
        const nodeIdx = target.topoOrder[idx]!;
        const node = nodes[nodeIdx]!;
        const off = nodeIdx * TRS_STRIDE;
        if (node._matrix) {
            localMat.set(node._matrix, nodeIdx * 16);
        } else {
            mat4ComposeInto(
                localMat,
                nodeIdx * 16,
                trs[off + T_OFF]!,
                trs[off + T_OFF + 1]!,
                trs[off + T_OFF + 2]!,
                trs[off + R_OFF]!,
                trs[off + R_OFF + 1]!,
                trs[off + R_OFF + 2]!,
                trs[off + R_OFF + 3]!,
                trs[off + S_OFF]!,
                trs[off + S_OFF + 1]!,
                trs[off + S_OFF + 2]!
            );
        }

        const parentIdx = node.parentIdx;
        if (parentIdx >= 0) {
            mat4MultiplyInto(worldMat, nodeIdx * 16, worldMat, parentIdx * 16, localMat, nodeIdx * 16);
        } else {
            mat4MultiplyInto(worldMat, nodeIdx * 16, RH_TO_LH, 0, localMat, nodeIdx * 16);
        }
    }

    for (let skeletonIndex = 0; skeletonIndex < target.skeletons.length; skeletonIndex++) {
        const skel = target.skeletons[skeletonIndex]!;
        const boneData = skel.boneMatrices;
        for (let bi = 0; bi < skel.boneCount; bi++) {
            const jointIdx = skel.jointNodes[bi]!;
            const ibmOff = bi * 16;
            mat4MultiplyInto(_boneTmp, 0, skel.invMeshWorld as unknown as Mat4Storage, 0, worldMat, jointIdx * 16);
            mat4MultiplyInto(boneData, bi * 16, _boneTmp, 0, skel.inverseBindMatrices, ibmOff);
        }

        const texWidth = skel.boneCount * 4;
        device.queue.writeTexture({ texture: skel.boneTexture }, boneData.buffer, { bytesPerRow: texWidth * 16 }, { width: texWidth, height: 1 });
    }
}

function computeTopoOrder(nodes: readonly { readonly parentIdx: number }[]): Int32Array {
    const order = new I32(nodes.length);
    const visited = new U8(nodes.length);
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

    for (let i = 0; i < nodes.length; i++) {
        visit(i);
    }
    return order;
}

function normalizeQuaternionAt(values: Float32Array, offset: number): void {
    const x = values[offset]!;
    const y = values[offset + 1]!;
    const z = values[offset + 2]!;
    const w = values[offset + 3]!;
    const lenSq = x * x + y * y + z * z + w * w;
    if (lenSq > 0) {
        const inv = 1 / Math.sqrt(lenSq);
        values[offset] = x * inv;
        values[offset + 1] = y * inv;
        values[offset + 2] = z * inv;
        values[offset + 3] = w * inv;
    }
}

function quatRefInverseTimesSample(out: Float32Array, ref: Float32Array, sample: Float32Array): void {
    const ax = -ref[0]!;
    const ay = -ref[1]!;
    const az = -ref[2]!;
    const aw = ref[3]!;
    const bx = sample[0]!;
    const by = sample[1]!;
    const bz = sample[2]!;
    const bw = sample[3]!;
    out[0] = aw * bx + ax * bw + ay * bz - az * by;
    out[1] = aw * by - ax * bz + ay * bw + az * bx;
    out[2] = aw * bz + ax * by - ay * bx + az * bw;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    normalizeQuaternionAt(out, 0);
}

function applyAdditiveQuaternion(base: Float32Array, offset: number, delta: Float32Array, weight: number): void {
    const bx = base[offset]!;
    const by = base[offset + 1]!;
    const bz = base[offset + 2]!;
    const bw = base[offset + 3]!;
    const dx = delta[0]!;
    const dy = delta[1]!;
    const dz = delta[2]!;
    const dw = delta[3]!;
    quatSlerpInto(
        base,
        offset,
        bx,
        by,
        bz,
        bw,
        bw * dx + bx * dw + by * dz - bz * dy,
        bw * dy - bx * dz + by * dw + bz * dx,
        bw * dz + bx * dy - by * dx + bz * dw,
        bw * dw - bx * dx - by * dy - bz * dz,
        weight
    );
}

function quatSlerpInto(out: Float32Array, offset: number, ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number, t: number): void {
    let dot = ax * bx + ay * by + az * bz + aw * bw;
    if (dot < 0) {
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
        dot = -dot;
    }
    if (dot > 0.9995) {
        out[offset] = ax + t * (bx - ax);
        out[offset + 1] = ay + t * (by - ay);
        out[offset + 2] = az + t * (bz - az);
        out[offset + 3] = aw + t * (bw - aw);
        normalizeQuaternionAt(out, offset);
        return;
    }
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / sinTheta;
    const wb = Math.sin(t * theta) / sinTheta;
    out[offset] = wa * ax + wb * bx;
    out[offset + 1] = wa * ay + wb * by;
    out[offset + 2] = wa * az + wb * bz;
    out[offset + 3] = wa * aw + wb * bw;
}
