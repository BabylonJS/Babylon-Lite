// Per-frame skeleton animation — evaluates clips and uploads bone matrices.
// Zero per-frame allocation: all scratch buffers pre-allocated at init.

import { F32, I32, U8 } from "../engine/typed-arrays.js";
import type { EngineContext } from "../engine/engine.js";
import type { AnimationClip, NodeRest, SkeletonBinding, AnimatedNodeTarget } from "../animation/types.js";
import type { MorphBinding } from "../animation/types.js";
import type { AnimationGroupMask } from "../animation/animation-group-mask.js";
import { PATH_TRANSLATION, PATH_ROTATION, PATH_SCALE, PATH_WEIGHTS, PATH_POINTER } from "../animation/types.js";
import { evaluateSampler } from "../animation/evaluate.js";
import { mat4ComposeInto } from "../math/mat4-compose-into.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import type { Mat4Storage } from "../math/types.js";
import type { BoneOverride } from "./bone-control.js";
import { _boneApplier } from "./bone-control-hooks.js";

// Scratch 4x4 used during bone-matrix composition; reused across frames + bones.
const _boneTmp = new F32(16);

/** Resolver that maps an {@link AnimationGroupMask} to per-node skip flags. Installed by
 *  `createAnimationGroupMask` (animation-group-mask.ts) on first use; stays null otherwise
 *  so the controller's masking branch tree-shakes for scenes that never mask. */
type AnimationMaskResolver = (mask: AnimationGroupMask, nodeNames: readonly (string | undefined)[], out: Uint8Array, numNodes: number) => void;
let _maskResolver: AnimationMaskResolver | null = null;
/** @internal Install the animation-mask resolver (called by `createAnimationGroupMask`). */
export function _installAnimationMaskResolver(resolver: AnimationMaskResolver): void {
    _maskResolver = resolver;
}

// RH→LH root transform (same as load-gltf.ts): diag(-1, 1, 1, 1)
// prettier-ignore
const RH_TO_LH = new F32([-1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1]);

/** TRS layout per node in the scratch buffer: 12 floats.
 *  [0..2] = translation, [3..6] = rotation (xyzw), [7..9] = scale, [10..11] = padding */
const TRS_STRIDE = 12;
const T_OFF = 0;
const R_OFF = 3;
const S_OFF = 7;

/** Compute topological order so parents are processed before children. */
function computeTopoOrder(nodes: readonly { readonly parentIdx: number }[]): Int32Array {
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
    /** @internal Apply an include/exclude target-name mask (or null to clear). Resolves the
     *  mask's names to the node indices whose channels should be skipped this playback. */
    _setMask?(mask: AnimationGroupMask | null): void;
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
): AnimationController;
// Overload with the optional opt-in bone-control override map. Kept as a separate
// overload so the original signature's API-report lines stay byte-identical (the
// breaking-change diff treats an appended param on the multi-line render as a
// changed last-param line — see report-api-changes.ts).
export function createAnimationController(
    clip: AnimationClip,
    nodes: readonly NodeRest[],
    skeletons: readonly SkeletonBinding[],
    morphBindings: readonly MorphBinding[],
    nodeTargets: readonly (AnimatedNodeTarget | undefined)[] | undefined,
    excludedNodeIndices: ReadonlySet<number> | undefined,
    boneOverrides: ReadonlyMap<number, unknown> | undefined
): AnimationController;
// Further overload adding the optional animation-mask node names. A separate overload (not
// an appended param on the bone-control overload above) so that overload's API-report lines
// stay byte-identical — see report-api-changes.ts.
export function createAnimationController(
    clip: AnimationClip,
    nodes: readonly NodeRest[],
    skeletons: readonly SkeletonBinding[],
    morphBindings: readonly MorphBinding[],
    nodeTargets: readonly (AnimatedNodeTarget | undefined)[] | undefined,
    excludedNodeIndices: ReadonlySet<number> | undefined,
    boneOverrides: ReadonlyMap<number, unknown> | undefined,
    nodeNames?: readonly (string | undefined)[]
): AnimationController;
export function createAnimationController(
    clip: AnimationClip,
    nodes: readonly NodeRest[],
    skeletons: readonly SkeletonBinding[],
    morphBindings: readonly MorphBinding[],
    nodeTargets?: readonly (AnimatedNodeTarget | undefined)[],
    excludedNodeIndices?: ReadonlySet<number>,
    boneOverrides?: ReadonlyMap<number, unknown>,
    nodeNames?: readonly (string | undefined)[]
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
    const currentTRS = new F32(numNodes * TRS_STRIDE);
    const localMat = new F32(numNodes * 16);
    const worldMat = new F32(numNodes * 16);
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
    const morphUploadF32 = new F32(4);
    // Pointer-channel scratch (sized to largest registered pointer arity).
    // Current registered writers need at most 4 (quaternion/color4). Keep 16 for headroom.
    const pointerScratch = new F32(16);

    let cachedEngine: EngineContext | undefined;

    // ── Animation mask (include/exclude targets by name) ──────────────────────────
    // `maskedNodes[i] = 1` marks node i's channels to be skipped this playback, so the
    // node keeps its rest-pose TRS (matching Babylon.js, which pauses masked targets).
    // The resolver is installed only when a scene creates a mask (createAnimationGroupMask),
    // so unmasked scenes keep `_maskResolver` null and this whole branch tree-shakes.
    // `maskedNodes` is allocated lazily on first real mask use — zero cost otherwise.
    let maskedNodes: Uint8Array | null = null;
    let maskActive = false;
    let cMask: AnimationGroupMask | null = null;
    let cNames: readonly string[] | null = null;
    let cLen = -1;
    let cMode = -1;
    let cDisabled = false;

    const _setMask = (mask: AnimationGroupMask | null): void => {
        if (!mask || mask.disabled || !nodeNames || !_maskResolver) {
            maskActive = false;
            return;
        }
        const names = mask.names;
        if (mask === cMask && names === cNames && names.length === cLen && mask.mode === cMode && mask.disabled === cDisabled) {
            maskActive = true;
            return;
        }
        cMask = mask;
        cNames = names;
        cLen = names.length;
        cMode = mask.mode;
        cDisabled = mask.disabled;
        if (!maskedNodes) {
            maskedNodes = new U8(numNodes);
        }
        _maskResolver(mask, nodeNames, maskedNodes, numNodes);
        maskActive = true;
    };

    const ctrl: AnimationController = {
        time: 0,
        playing: true,
        speedRatio: 1,
        loop: true,
        _setMask,
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

                      // 1b. Apply user bone overrides (opt-in bone control) on top of
                      // the rest pose, BEFORE channels so animation wins per-component.
                      // Routed through a null hook so the apply code stays in the opt-in
                      // bone-control chunk — bone-control-free bundles pay one branch.
                      if (boneOverrides !== undefined && boneOverrides.size > 0) {
                          _boneApplier?.(boneOverrides as ReadonlyMap<number, BoneOverride>, currentTRS, numNodes);
                      }

                      // 2. Evaluate animation channels → override TRS
                      for (let channelIndex = 0; channelIndex < clip.channels.length; channelIndex++) {
                          const ch = clip.channels[channelIndex]!;
                          // Skip channels whose target node is masked out — the node keeps its
                          // rest-pose TRS from step 1 (matches Babylon.js pausing masked targets).
                          // Gated on `_maskResolver` so the entire branch (and `maskActive` /
                          // `maskedNodes`) folds away for bundles that never create a mask.
                          if (_maskResolver !== null && maskActive && ch.nodeIdx >= 0 && maskedNodes![ch.nodeIdx]) {
                              continue;
                          }
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
