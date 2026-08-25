// Bone visibility (`setBoneVisible`) must beat animation.
//
// Hiding a bone is a visibility control, not a transform override: it is re-applied AFTER
// channel evaluation. Without that, any clip with a scale track on the bone silently
// un-hides it — and virtually every rig in the wild (all Mixamo exports, e.g. Xbot.glb)
// bakes a constant scale track onto every single bone. These tests drive both pose paths
// (single-clip controller + weighted manager blend) and the eager no-animation bake.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAnimationManager, updateAnimationManager } from "../../../packages/babylon-lite/src/animation/animation-manager";
import { addAnimationGroup } from "../../../packages/babylon-lite/src/animation/animation-group-task";
import type { AnimationGltfMixer, AnimationGroup } from "../../../packages/babylon-lite/src/animation/animation-group";
import { enableAnimationBlending } from "../../../packages/babylon-lite/src/animation/weighted-gltf-mixer";
import { INTERP_LINEAR, PATH_SCALE } from "../../../packages/babylon-lite/src/animation/types";
import type { AnimationClip, NodeRest, SkeletonBinding, SkeletonData } from "../../../packages/babylon-lite/src/animation/types";
import { enableBoneControl, setBoneScaling, setBoneVisible } from "../../../packages/babylon-lite/src/skeleton/bone-control";
import type { Bone, BoneOverride, Skeleton } from "../../../packages/babylon-lite/src/skeleton/bone-control";
import { createAnimationController } from "../../../packages/babylon-lite/src/skeleton/skeleton-updater";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";

const JOINT_NAME = "joint";
const HIDDEN_MASK = 8;
const SCALE_MASK = 4;

function identityMat4(): Float32Array {
    // prettier-ignore
    return new Float32Array([1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1]);
}

function createRestNode(): NodeRest {
    return { parentIdx: -1, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, rw: 1, sx: 1, sy: 1, sz: 1 };
}

/** Single-joint binding with identity bind matrices: the uploaded bone matrix is just
 *  `RH_TO_LH * localMatrix`, i.e. the joint's TRS with X negated. */
function createBinding(overrides?: Map<number, BoneOverride>): SkeletonBinding {
    return {
        jointNodes: [0],
        inverseBindMatrices: identityMat4(),
        invMeshWorld: identityMat4() as unknown as Mat4,
        boneTexture: {} as GPUTexture,
        boneCount: 1,
        boneMatrices: new Float32Array(16),
        runtimeSkeleton: { _overrides: overrides } as unknown as SkeletonData,
    };
}

/** Clip pinning the joint's scale to a constant 1 — exactly what a Mixamo export bakes
 *  onto every bone, and what silently defeated `setBoneVisible` before the fix. */
function createConstantScaleClip(): AnimationClip {
    return {
        name: "scale",
        channels: [{ samplerIdx: 0, nodeIdx: 0, path: PATH_SCALE }],
        samplers: [{ input: new Float32Array([0, 1]), output: new Float32Array([1, 1, 1, 1, 1, 1]), interpolation: INTERP_LINEAR }],
        duration: 1,
        frameRate: 60,
    };
}

function boneDiagonal(binding: SkeletonBinding): number[] {
    const m = binding.boneMatrices;
    return [m[0]!, m[5]!, m[10]!, m[15]!];
}

/** Minimal in-memory `Skeleton` over a shared override map, so the public setters can be
 *  exercised without a glTF load. `_bake` just records that it ran. */
function createSkeleton(overrides: Map<number, BoneOverride>, bake: () => void = (): void => {}): { skeleton: Skeleton; bone: Bone } {
    const bone: Bone = { name: JOINT_NAME, _nodeIndex: 0 };
    return { skeleton: { bones: [bone], _byName: new Map([[JOINT_NAME, bone]]), _overrides: overrides, _worldOverrides: new Map(), _bake: bake }, bone };
}

describe("bone visibility", () => {
    beforeEach(() => {
        enableBoneControl();
    });

    it("marks a hidden bone with the hidden bit, not a scale override", () => {
        const overrides = new Map<number, BoneOverride>();
        const { skeleton, bone } = createSkeleton(overrides);

        setBoneVisible(skeleton, bone, false);
        expect(overrides.get(0)!.mask).toBe(HIDDEN_MASK);

        setBoneVisible(skeleton, bone, true);
        expect(overrides.has(0)).toBe(false);
    });

    it("keeps an explicit scale override when the bone is shown again", () => {
        const overrides = new Map<number, BoneOverride>();
        const { skeleton, bone } = createSkeleton(overrides);

        setBoneScaling(skeleton, bone, 2, 2, 2);
        setBoneVisible(skeleton, bone, false);
        expect(overrides.get(0)!.mask).toBe(SCALE_MASK | HIDDEN_MASK);

        setBoneVisible(skeleton, bone, true);
        const o = overrides.get(0)!;
        expect(o.mask).toBe(SCALE_MASK);
        expect([o.sx, o.sy, o.sz]).toEqual([2, 2, 2]);
    });

    it("stays hidden while a scale-animating clip plays on the single-clip path", () => {
        const overrides = new Map<number, BoneOverride>([[0, { mask: HIDDEN_MASK, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, rw: 1, sx: 1, sy: 1, sz: 1 }]]);
        const binding = createBinding(overrides);
        const engine = { _device: { queue: { writeTexture: vi.fn() } } } as unknown as EngineContext;

        const ctrl = createAnimationController(createConstantScaleClip(), [createRestNode()], [binding], [], undefined, undefined, overrides);
        ctrl.tick(16, engine);

        expect(boneDiagonal(binding)).toEqual([0, 0, 0, 1]);
    });

    it("stays hidden while a scale-animating clip plays through the weighted manager blend", () => {
        const overrides = new Map<number, BoneOverride>([[0, { mask: HIDDEN_MASK, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, rw: 1, sx: 1, sy: 1, sz: 1 }]]);
        const binding = createBinding(overrides);
        const mixer: AnimationGltfMixer = [createConstantScaleClip(), [createRestNode()], [binding]];
        const group: AnimationGroup = {
            name: "clip",
            duration: 1,
            frameRate: 60,
            isPlaying: true,
            currentTime: 0,
            targetedAnimations: [{ targetName: JOINT_NAME, nodeIndex: 0, path: "scale" }],
            speedRatio: 1,
            loopAnimation: true,
            weight: 0.5,
            _stopped: false,
        };
        group._gltfMixer = mixer;

        const engine = { _device: { queue: { writeTexture: vi.fn() } } } as unknown as EngineContext;
        const manager = createAnimationManager({ engine });
        enableAnimationBlending(manager);
        addAnimationGroup(manager, group);

        updateAnimationManager(manager, 16);
        expect(boneDiagonal(binding)).toEqual([0, 0, 0, 1]);

        // And un-hiding restores the animated scale on the next tick.
        overrides.clear();
        updateAnimationManager(manager, 16);
        expect(boneDiagonal(binding)).toEqual([-0.5, 0.5, 0.5, 1]);
    });
});
