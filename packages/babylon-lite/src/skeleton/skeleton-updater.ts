// Per-frame skeleton animation — evaluates clips and uploads bone matrices.
// Zero per-frame allocation: all scratch buffers pre-allocated at init.

import type { EngineContext } from "../engine/engine.js";
import type { AnimationClip, NodeRest, SkeletonBinding, AnimatedNodeTarget } from "../animation/types.js";
import type { MorphBinding } from "../animation/types.js";
import { PATH_TRANSLATION, PATH_ROTATION, PATH_SCALE, PATH_WEIGHTS, PATH_POINTER } from "../animation/types.js";
import { evaluateSampler } from "../animation/evaluate.js";
import { mat4ComposeInto } from "../math/mat4-compose-into.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import type { Mat4Storage } from "../math/types.js";

// Scratch 4x4 used during bone-matrix composition; reused across frames + bones.
const _boneTmp = new Float32Array(16);

// RH→LH root transform (same as load-gltf.ts): diag(-1, 1, 1, 1)
// prettier-ignore
const RH_TO_LH = new Float32Array([-1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1]);

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

/** Drives playback of a skeletal/morph animation clip, advancing time and uploading bone matrices each tick. */
export interface AnimationController {
    /** Advance animation by deltaMs and update bone textures. */
    tick(deltaMs: number, engine?: EngineContext): void;
    /** Current playback time in seconds. */
    time: number;
    /** True if playing. */
    playing: boolean;
    /** Playback speed multiplier (default 1). */
    speedRatio: number;
    /** Whether animation loops (default true). */
    loop: boolean;
    /** @internal Debug: node world matrices (numNodes × 16 floats, column-major). */
    readonly _debugWorldMat?: Float32Array;
    /** @internal Debug: node names. */
    readonly _debugNodeNames?: string[];
}

/**
 * Create a skeleton animation controller from parsed glTF animation data.
 * Returns a tick function that advances the animation and uploads bone matrices.
 */
export function createAnimationController(
    clip: AnimationClip,
    nodes: readonly NodeRest[],
    skeletons: readonly SkeletonBinding[],
    morphBindings: readonly MorphBinding[],
    nodeTargets?: readonly (AnimatedNodeTarget | undefined)[],
    excludedNodeIndices?: ReadonlySet<number>
): AnimationController {
    const requiresEngine = skeletons.length > 0 || morphBindings.length > 0;
    const numNodes = nodes.length;

    // Plain node-TRS bindings: glTF translation/rotation/scale channels that target
    // a non-excluded node with a live scene node. These move node-animated meshes
    // (and their descendants) — without this, only skeleton/morph/pointer outputs
    // would be applied and node-animated meshes would stay frozen at their rest pose.
    // Excluded nodes are skin joints + skinned-mesh nodes and their ancestors. A
    // binding list is per-clip: only nodes THIS clip animates are kept, so untouched
    // nodes never needlessly dirty the scene. mask bits: 1 = translation, 2 = rotation,
    // 4 = scale.
    const nodeTrsBindings: { target: AnimatedNodeTarget; off: number; mask: number }[] = [];
    if (nodeTargets) {
        const maskByNode = new Map<number, number>();
        for (let ci = 0; ci < clip.channels.length; ci++) {
            const ch = clip.channels[ci]!;
            const bit = ch.path === PATH_TRANSLATION ? 1 : ch.path === PATH_ROTATION ? 2 : ch.path === PATH_SCALE ? 4 : 0;
            if (bit === 0) {
                continue;
            }
            const ni = ch.nodeIdx;
            if (ni < 0 || excludedNodeIndices?.has(ni) || !nodeTargets[ni]) {
                continue;
            }
            maskByNode.set(ni, (maskByNode.get(ni) ?? 0) | bit);
        }
        for (const [ni, mask] of maskByNode) {
            nodeTrsBindings.push({ target: nodeTargets[ni]!, off: ni * TRS_STRIDE, mask });
        }
    }

    // Pre-allocate scratch buffers (once)
    const currentTRS = new Float32Array(numNodes * TRS_STRIDE);
    const localMat = new Float32Array(numNodes * 16);
    const worldMat = new Float32Array(numNodes * 16);
    const topoOrder = computeTopoOrder(nodes);

    // Per-skeleton bone scratch
    const boneScratch = skeletons.map((s) => s.boneMatrices);

    // Per-morph-binding scratch for weight evaluation
    const morphBindingsByNode: (MorphBinding[] | undefined)[] = [];
    for (let morphIndex = 0; morphIndex < morphBindings.length; morphIndex++) {
        const mb = morphBindings[morphIndex]!;
        let arr = morphBindingsByNode[mb.nodeIdx];
        if (!arr) {
            arr = [];
            morphBindingsByNode[mb.nodeIdx] = arr;
        }
        arr.push(mb);
    }
    // Only write first 16 bytes (weights vec4) — count/texWidth/rowsPerBand are immutable
    const morphUploadF32 = new Float32Array(4);
    // Pointer-channel scratch (sized to largest registered pointer arity).
    // Current registered writers need at most 4 (quaternion/color4). Keep 16 for headroom.
    const pointerScratch = new Float32Array(16);

    let cachedEngine: EngineContext | undefined;

    const ctrl: AnimationController = {
        time: 0,
        playing: true,
        speedRatio: 1,
        loop: true,
        _debugWorldMat: worldMat,

        tick:
            clip.duration <= 0
                ? noopAnimationTick
                : (deltaMs: number, engine?: EngineContext): void => {
                      if (engine) {
                          cachedEngine = engine;
                      }
                      const activeEngine = engine ?? cachedEngine;
                      if (requiresEngine && !activeEngine) {
                          throw new Error("AnimationController.tick requires an EngineContext for skeleton or morph animation");
                      }
                      const device = requiresEngine ? activeEngine!._device : null;

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
                          ctrl.time = Math.min(Math.max(ctrl.time, 0), clip.duration);
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
                      for (let channelIndex = 0; channelIndex < clip.channels.length; channelIndex++) {
                          const ch = clip.channels[channelIndex]!;
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
                                  const bindings = morphBindingsByNode[ch.nodeIdx];
                                  if (bindings) {
                                      const tc = bindings[0]!.targetCount;
                                      morphUploadF32.fill(0);
                                      evaluateSampler(sampler, t, tc, false, morphUploadF32, 0);
                                      for (let bindingIndex = 0; bindingIndex < bindings.length; bindingIndex++) {
                                          const mb = bindings[bindingIndex]!;
                                          mb.weights.set(morphUploadF32);
                                          // Write only the weights vec4 (first 16 bytes); count/texWidth/rowsPerBand are immutable
                                          device!.queue.writeBuffer(mb.runtimeMorphTargets?.weightsBuffer ?? mb.weightsBuffer, 0, morphUploadF32.buffer, 0, 16);
                                      }
                                  }
                                  break;
                              }
                              case PATH_POINTER: {
                                  if (ch.pointerArity && ch.pointerWriter) {
                                      evaluateSampler(sampler, t, ch.pointerArity, ch.pointerQuaternion === true, pointerScratch, 0);
                                      ch.pointerWriter(pointerScratch, 0);
                                  }
                                  break;
                              }
                          }
                      }

                      // 2b. Apply plain node-TRS channels to the live scene graph so
                      // node-animated meshes (and their descendants) move. Skeleton
                      // joints + skinned-mesh chains are excluded (handled by the bone
                      // path below). The skeleton path is independent: it reads `nodes`
                      // and uploads bone textures, never the scene hierarchy.
                      for (let bi = 0; bi < nodeTrsBindings.length; bi++) {
                          const b = nodeTrsBindings[bi]!;
                          const o = b.off;
                          if (b.mask & 1) {
                              b.target.position.set(currentTRS[o + T_OFF]!, currentTRS[o + T_OFF + 1]!, currentTRS[o + T_OFF + 2]!);
                          }
                          if (b.mask & 2) {
                              b.target.rotationQuaternion.set(currentTRS[o + R_OFF]!, currentTRS[o + R_OFF + 1]!, currentTRS[o + R_OFF + 2]!, currentTRS[o + R_OFF + 3]!);
                          }
                          if (b.mask & 4) {
                              b.target.scaling.set(currentTRS[o + S_OFF]!, currentTRS[o + S_OFF + 1]!, currentTRS[o + S_OFF + 2]!);
                          }
                      }

                      // 3. Compute local → world matrices in topological order
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
                              mat4MultiplyInto(_boneTmp, 0, skel.invMeshWorld as unknown as Mat4Storage, 0, worldMat, jointIdx * 16);
                              mat4MultiplyInto(boneData, bi * 16, _boneTmp, 0, skel.inverseBindMatrices, ibmOff);
                          }

                          // Upload to GPU
                          const texWidth = skel.boneCount * 4;
                          device!.queue.writeTexture(
                              { texture: skel.runtimeSkeleton?.boneTexture ?? skel.boneTexture },
                              boneData.buffer,
                              { bytesPerRow: texWidth * 16 },
                              { width: texWidth, height: 1 }
                          );
                      }
                  },
    };

    return ctrl;
}

function noopAnimationTick(): void {
    // Empty controller for zero-duration clips.
}
