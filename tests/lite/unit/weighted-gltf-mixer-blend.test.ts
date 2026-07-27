// Weighted glTF mixer — bone-control overrides + animation-group masks.
//
// The manager blend path (`enableAnimationBlending`) recomputes bone poses from scratch,
// so it has to re-apply the two things the single-clip controller path applies itself:
// user bone overrides (pre-accumulation) and animation-group masks (per channel).
// These tests drive the mixer through the public manager API with a one-joint skeleton
// and read back the uploaded bone matrix.

import { beforeEach, describe, expect, it } from "vitest";

import { createAnimationManager, updateAnimationManager } from "../../../packages/babylon-lite/src/animation/animation-manager";
import type { AnimationManager } from "../../../packages/babylon-lite/src/animation/animation-manager";
import { addAnimationGroup } from "../../../packages/babylon-lite/src/animation/animation-group-task";
import type { AnimationGltfMixer, AnimationGroup } from "../../../packages/babylon-lite/src/animation/animation-group";
import { enableAnimationBlending, setAnimationAdditive } from "../../../packages/babylon-lite/src/animation/weighted-gltf-mixer";
import { AnimationGroupMaskMode, createAnimationGroupMask } from "../../../packages/babylon-lite/src/animation/animation-group-mask";
import { INTERP_LINEAR, PATH_SCALE } from "../../../packages/babylon-lite/src/animation/types";
import type { AnimationClip, NodeRest, SkeletonBinding, SkeletonData } from "../../../packages/babylon-lite/src/animation/types";
import { enableBoneControl } from "../../../packages/babylon-lite/src/skeleton/bone-control";
import type { BoneOverride } from "../../../packages/babylon-lite/src/skeleton/bone-control";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";

const JOINT_NAME = "joint";
const OVERRIDE_SCALE_MASK = 4;

function identityMat4(): Float32Array {
    // prettier-ignore
    return new Float32Array([1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1]);
}

function createRestNode(): NodeRest {
    return { parentIdx: -1, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, rw: 1, sx: 1, sy: 1, sz: 1 };
}

/** Single-joint skeleton binding with identity bind matrices, so the uploaded bone matrix
 *  is just `RH_TO_LH * localMatrix` — i.e. the joint's TRS with X negated. */
function createBinding(overrides?: Map<number, BoneOverride>): SkeletonBinding {
    const runtimeSkeleton = { _overrides: overrides } as unknown as SkeletonData;
    return {
        jointNodes: [0],
        inverseBindMatrices: identityMat4(),
        invMeshWorld: identityMat4() as unknown as SkeletonBinding["invMeshWorld"],
        boneTexture: {} as unknown as GPUTexture,
        boneCount: 1,
        boneMatrices: new Float32Array(16),
        runtimeSkeleton,
    };
}

/** Clip animating the joint's scale linearly from 1 (t=0) to 5 (t=1). */
function createScaleClip(): AnimationClip {
    return {
        name: "scale",
        channels: [{ samplerIdx: 0, nodeIdx: 0, path: PATH_SCALE }],
        samplers: [
            {
                input: new Float32Array([0, 1]),
                output: new Float32Array([1, 1, 1, 5, 5, 5]),
                interpolation: INTERP_LINEAR,
            },
        ],
        duration: 1,
        frameRate: 60,
    };
}

function createGroup(mixer: AnimationGltfMixer, weight: number): AnimationGroup {
    const group: AnimationGroup = {
        name: "clip",
        duration: mixer[0].duration,
        frameRate: 60,
        isPlaying: true,
        currentTime: 0,
        targetedAnimations: mixer[0].channels.map(() => ({ targetName: JOINT_NAME, nodeIndex: 0, path: "scale" })),
        speedRatio: 1,
        loopAnimation: true,
        weight,
        _stopped: false,
    };
    group._gltfMixer = mixer;
    return group;
}

function createManager(): AnimationManager {
    const engine = { _device: { queue: { writeTexture: () => {} } } } as unknown as EngineContext;
    const manager = createAnimationManager({ engine });
    enableAnimationBlending(manager);
    return manager;
}

/** Diagonal of the uploaded bone matrix — enough to read back the joint's blended scale
 *  (X is negated by the RH→LH root transform the mixer applies to root nodes). */
function boneDiagonal(binding: SkeletonBinding): number[] {
    const m = binding.boneMatrices;
    return [m[0]!, m[5]!, m[10]!, m[15]!];
}

describe("weighted glTF mixer — bone overrides and masks", () => {
    beforeEach(() => {
        enableBoneControl();
    });

    it("applies bone overrides on the very first weighted tick", () => {
        const overrides = new Map<number, BoneOverride>([[0, { mask: OVERRIDE_SCALE_MASK, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, rw: 1, sx: 2, sy: 2, sz: 2 }]]);
        const binding = createBinding(overrides);
        const group = createGroup([createScaleClip(), [createRestNode()], [binding]], 0.5);
        // Include mask that matches nothing — every channel is masked out, so the override is
        // the only thing writing the joint's scale.
        group.mask = createAnimationGroupMask(["someOtherBone"], AnimationGroupMaskMode.Include);

        const manager = createManager();
        addAnimationGroup(manager, group);

        updateAnimationManager(manager, 16);
        const firstTick = boneDiagonal(binding);
        updateAnimationManager(manager, 16);
        const secondTick = boneDiagonal(binding);

        expect(firstTick).toEqual([-2, 2, 2, 1]);
        expect(firstTick).toEqual(secondTick);
    });

    it("keeps an unanimated overridden bone stable from the first tick", () => {
        const overrides = new Map<number, BoneOverride>([[0, { mask: OVERRIDE_SCALE_MASK, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, rw: 1, sx: 3, sy: 3, sz: 3 }]]);
        const binding = createBinding(overrides);
        // Clip with no channels at all: nothing animates the joint, so the override must hold.
        const emptyClip: AnimationClip = { name: "empty", channels: [], samplers: [], duration: 1, frameRate: 60 };
        const group = createGroup([emptyClip, [createRestNode()], [binding]], 0.5);

        const manager = createManager();
        addAnimationGroup(manager, group);

        updateAnimationManager(manager, 16);
        const firstTick = boneDiagonal(binding);
        updateAnimationManager(manager, 16);

        expect(firstTick).toEqual([-3, 3, 3, 1]);
        expect(boneDiagonal(binding)).toEqual(firstTick);
    });

    it("lets an animated channel win over an override for the same component", () => {
        const overrides = new Map<number, BoneOverride>([[0, { mask: OVERRIDE_SCALE_MASK, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, rw: 1, sx: 2, sy: 2, sz: 2 }]]);
        const binding = createBinding(overrides);
        const group = createGroup([createScaleClip(), [createRestNode()], [binding]], 0.5);

        const manager = createManager();
        addAnimationGroup(manager, group);

        // t = 0.5s → sampled scale 3, weighted by 0.5 → 1.5 (the override's 2 is overwritten).
        updateAnimationManager(manager, 500);

        expect(boneDiagonal(binding)).toEqual([-1.5, 1.5, 1.5, 1]);
    });

    it("skips masked-out channels when accumulating a weighted group", () => {
        const binding = createBinding();
        const group = createGroup([createScaleClip(), [createRestNode()], [binding]], 0.5);
        group.mask = createAnimationGroupMask([JOINT_NAME], AnimationGroupMaskMode.Exclude);

        const manager = createManager();
        addAnimationGroup(manager, group);
        updateAnimationManager(manager, 500);

        // Masked out → rest pose (scale 1) instead of the weighted sample (1.5).
        expect(boneDiagonal(binding)).toEqual([-1, 1, 1, 1]);

        group.mask.disabled = true;
        group.currentTime = 0;
        updateAnimationManager(manager, 500);
        expect(boneDiagonal(binding)).toEqual([-1.5, 1.5, 1.5, 1]);
    });

    it("skips masked-out channels when accumulating an additive group", () => {
        const binding = createBinding();
        const group = createGroup([createScaleClip(), [createRestNode()], [binding]], 1);
        setAnimationAdditive(group, { referenceTime: 0 });
        group.mask = createAnimationGroupMask([JOINT_NAME], AnimationGroupMaskMode.Exclude);

        const manager = createManager();
        addAnimationGroup(manager, group);
        updateAnimationManager(manager, 500);

        // Masked out → the additive delta is not applied, so the joint stays at rest.
        expect(boneDiagonal(binding)).toEqual([-1, 1, 1, 1]);

        group.mask.disabled = true;
        group.currentTime = 0;
        updateAnimationManager(manager, 500);
        // t = 0.5s → sample 3 minus reference 1 → +2 on top of the rest scale 1.
        expect(boneDiagonal(binding)).toEqual([-3, 3, 3, 1]);
    });
});
