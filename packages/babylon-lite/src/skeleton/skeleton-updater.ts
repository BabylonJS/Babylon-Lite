// Per-frame skeleton animation — evaluates clips and uploads bone matrices.
// Zero per-frame allocation: all scratch buffers pre-allocated at init.

import type { EngineContextInternal } from "../engine/engine.js";
import type { GltfAnimationData, AnimationClip } from "../animation/types.js";
import type { MorphBinding } from "../animation/types.js";
import { PATH_TRANSLATION, PATH_ROTATION, PATH_SCALE, PATH_WEIGHTS, PATH_POINTER } from "../animation/types.js";
import { evaluateSampler } from "../animation/evaluate.js";
import { mat4ComposeInto, mat4MultiplyInto } from "../math/mat4.js";

// RH→LH root transform (same as load-gltf.ts): diag(-1, 1, 1, 1)
const RH_TO_LH = new Float32Array(16);
RH_TO_LH[0] = -1;
RH_TO_LH[5] = 1;
RH_TO_LH[10] = 1;
RH_TO_LH[15] = 1;

/** TRS layout per node in the scratch buffer: 12 floats.
 *  [0..2] = translation, [3..6] = rotation (xyzw), [7..9] = scale, [10..11] = padding */
const TRS_STRIDE = 12;
const T_OFF = 0;
const R_OFF = 3;
const S_OFF = 7;

/** Compute topological order so parents are processed before children. */
function computeTopoOrder(nodes: readonly { readonly parentIdx: number }[]): Int32Array {
    const n = nodes.length;
    const order = new Int32Array(n);
    const visited = new Uint8Array(n);
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

export interface AnimationController {
    /** Advance animation by deltaMs and update bone textures. */
    tick(deltaMs: number, engine: EngineContextInternal): void;
    /** Current playback time in seconds. */
    time: number;
    /** True if playing. */
    playing: boolean;
    /** Playback speed multiplier (default 1). */
    speedRatio: number;
    /** Whether animation loops (default true). */
    loop: boolean;
    /** Debug: node world matrices (numNodes × 16 floats, column-major). */
    readonly _debugWorldMat?: Float32Array;
    /** Debug: node names. */
    readonly _debugNodeNames?: string[];
}

/**
 * Create a skeleton animation controller from parsed glTF animation data.
 * Returns a tick function that advances the animation and uploads bone matrices.
 */
export function createAnimationController(animData: GltfAnimationData): AnimationController {
    const { clips, nodes, skeletons, morphBindings } = animData;
    const hasPointer = clips.some((c) => c.channels.some((ch) => ch.path === PATH_POINTER));
    if (clips.length === 0 || (skeletons.length === 0 && morphBindings.length === 0 && !hasPointer)) {
        return { tick() {}, time: 0, playing: false, speedRatio: 1, loop: true };
    }

    const clip: AnimationClip = clips[0]!;
    const numNodes = nodes.length;

    // Pre-allocate scratch buffers (once)
    const currentTRS = new Float32Array(numNodes * TRS_STRIDE);
    const localMat = new Float32Array(numNodes * 16);
    const worldMat = new Float32Array(numNodes * 16);
    const topoOrder = computeTopoOrder(nodes);

    // Per-skeleton bone scratch
    const boneScratch = skeletons.map((s) => new Float32Array(s.boneCount * 16));

    // Per-morph-binding scratch for weight evaluation
    const morphNodeMap = new Map<number, MorphBinding[]>();
    for (const mb of morphBindings) {
        let arr = morphNodeMap.get(mb.nodeIdx);
        if (!arr) {
            arr = [];
            morphNodeMap.set(mb.nodeIdx, arr);
        }
        arr.push(mb);
    }
    const morphWeightScratch = new Float32Array(8); // supports up to 8 weights evaluation
    // Only write first 16 bytes (weights vec4) — count/texWidth/rowsPerBand are immutable
    const morphUploadF32 = new Float32Array(4);
    // Pointer-channel scratch (sized to largest registered pointer arity).
    // Current registered writers need at most 4 (quaternion/color4). Keep 16 for headroom.
    const pointerScratch = new Float32Array(16);

    let _hasTickedOnce = false;

    const ctrl: AnimationController = {
        time: 0,
        playing: true,
        speedRatio: 1,
        loop: true,
        _debugWorldMat: worldMat,

        tick(deltaMs: number, engine: EngineContextInternal): void {
            const device = engine.device;
            if (clip.duration <= 0) {
                return;
            }

            // Skip if animation time hasn't changed (paused/static scene)
            if (deltaMs === 0 && _hasTickedOnce) {
                return;
            }
            _hasTickedOnce = true;

            if (ctrl.playing) {
                ctrl.time += (deltaMs / 1000) * ctrl.speedRatio;
            }

            // Always wrap/clamp — ensures externally-set time (goToFrame) is valid
            if (ctrl.loop) {
                ctrl.time %= clip.duration;
                if (ctrl.time < 0) {
                    ctrl.time += clip.duration;
                }
            } else {
                ctrl.time = Math.min(ctrl.time, clip.duration);
            }
            const t = ctrl.time;

            // 1. Reset to rest-pose TRS
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

            // 2. Evaluate animation channels → override TRS
            for (const ch of clip.channels) {
                const sampler = clip.samplers[ch.samplerIdx]!;
                const base = ch.nodeIdx * TRS_STRIDE;
                switch (ch.path) {
                    case PATH_TRANSLATION:
                        evaluateSampler(sampler, t, 3, false, currentTRS, base + T_OFF);
                        break;
                    case PATH_ROTATION:
                        evaluateSampler(sampler, t, 4, true, currentTRS, base + R_OFF);
                        break;
                    case PATH_SCALE:
                        evaluateSampler(sampler, t, 3, false, currentTRS, base + S_OFF);
                        break;
                    case PATH_WEIGHTS: {
                        // Evaluate morph weights and upload to all bindings for this node
                        const bindings = morphNodeMap.get(ch.nodeIdx);
                        if (bindings) {
                            const tc = bindings[0]!.targetCount;
                            evaluateSampler(sampler, t, tc, false, morphWeightScratch, 0);
                            morphUploadF32[0] = morphWeightScratch[0]!;
                            morphUploadF32[1] = tc > 1 ? morphWeightScratch[1]! : 0;
                            morphUploadF32[2] = tc > 2 ? morphWeightScratch[2]! : 0;
                            morphUploadF32[3] = tc > 3 ? morphWeightScratch[3]! : 0;
                            for (const mb of bindings) {
                                // Write only the weights vec4 (first 16 bytes); count/texWidth/rowsPerBand are immutable
                                device.queue.writeBuffer(mb.weightsBuffer, 0, morphUploadF32.buffer, 0, 16);
                            }
                        }
                        break;
                    }
                    case PATH_POINTER: {
                        if (ch.pointerArity && ch.pointerWriter) {
                            evaluateSampler(sampler, t, ch.pointerArity, false, pointerScratch, 0);
                            ch.pointerWriter(pointerScratch, 0);
                        }
                        break;
                    }
                }
            }

            // 3. Compute local → world matrices in topological order
            for (let idx = 0; idx < numNodes; idx++) {
                const nodeIdx = topoOrder[idx]!;
                const off = nodeIdx * TRS_STRIDE;
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

                const parentIdx = nodes[nodeIdx]!.parentIdx;
                if (parentIdx >= 0) {
                    mat4MultiplyInto(worldMat, nodeIdx * 16, worldMat, parentIdx * 16, localMat, nodeIdx * 16);
                } else {
                    // Root node: pre-multiply RH→LH
                    mat4MultiplyInto(worldMat, nodeIdx * 16, RH_TO_LH, 0, localMat, nodeIdx * 16);
                }
            }

            // 4. Compute bone matrices and upload to GPU
            for (let si = 0; si < skeletons.length; si++) {
                const skel = skeletons[si]!;
                const boneData = boneScratch[si]!;

                for (let bi = 0; bi < skel.boneCount; bi++) {
                    const jointIdx = skel.jointNodes[bi]!;
                    const ibmOff = bi * 16;
                    // boneMatrix = invMeshWorld * jointWorld * IBM
                    // Step 1: temp = invMeshWorld * jointWorld
                    mat4MultiplyInto(boneData, bi * 16, skel.invMeshWorld, 0, worldMat, jointIdx * 16);
                    // Step 2: bone = temp * IBM (in-place: read temp from boneData, multiply with IBM slice)
                    // We need a temp for the intermediate result
                    const t0 = boneData[bi * 16]!,
                        t1 = boneData[bi * 16 + 1]!,
                        t2 = boneData[bi * 16 + 2]!,
                        t3 = boneData[bi * 16 + 3]!;
                    const t4 = boneData[bi * 16 + 4]!,
                        t5 = boneData[bi * 16 + 5]!,
                        t6 = boneData[bi * 16 + 6]!,
                        t7 = boneData[bi * 16 + 7]!;
                    const t8 = boneData[bi * 16 + 8]!,
                        t9 = boneData[bi * 16 + 9]!,
                        t10 = boneData[bi * 16 + 10]!,
                        t11 = boneData[bi * 16 + 11]!;
                    const t12 = boneData[bi * 16 + 12]!,
                        t13 = boneData[bi * 16 + 13]!,
                        t14 = boneData[bi * 16 + 14]!,
                        t15 = boneData[bi * 16 + 15]!;

                    const ibm = skel.inverseBindMatrices;
                    for (let col = 0; col < 4; col++) {
                        const b0 = ibm[ibmOff + col * 4]!,
                            b1 = ibm[ibmOff + col * 4 + 1]!,
                            b2 = ibm[ibmOff + col * 4 + 2]!,
                            b3 = ibm[ibmOff + col * 4 + 3]!;
                        boneData[bi * 16 + col * 4] = t0 * b0 + t4 * b1 + t8 * b2 + t12 * b3;
                        boneData[bi * 16 + col * 4 + 1] = t1 * b0 + t5 * b1 + t9 * b2 + t13 * b3;
                        boneData[bi * 16 + col * 4 + 2] = t2 * b0 + t6 * b1 + t10 * b2 + t14 * b3;
                        boneData[bi * 16 + col * 4 + 3] = t3 * b0 + t7 * b1 + t11 * b2 + t15 * b3;
                    }
                }

                // Upload to GPU
                const texWidth = skel.boneCount * 4;
                device.queue.writeTexture({ texture: skel.boneTexture }, boneData.buffer, { bytesPerRow: texWidth * 16 }, { width: texWidth, height: 1 });
            }
        },
    };

    return ctrl;
}
