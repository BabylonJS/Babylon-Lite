import { describe, expect, it, vi } from "vitest";

import { Animation, AnimationGroup, AnimationKeyInterpolation } from "../src/animations/animation";
import { QuadraticEase } from "../src/animations/easing";
import type { IAnimationKey, IEasingFunction } from "../src/index";
import { Quaternion } from "../src/math/quaternion";
import { Vector3 } from "../src/math/vector";
import type { AnimationGroup as LiteAnimationGroup } from "babylon-lite";
import { INTERP_CUBICSPLINE, INTERP_LINEAR, INTERP_STEP, PATH_POINTER, PATH_WEIGHTS } from "../../babylon-lite/src/animation/types";

describe("Animation", () => {
    it("exposes Babylon.js data-type and loop-mode constants", () => {
        expect(Animation.ANIMATIONTYPE_FLOAT).toBe(0);
        expect(Animation.ANIMATIONTYPE_VECTOR3).toBe(1);
        expect(Animation.ANIMATIONLOOPMODE_CYCLE).toBe(1);
    });

    it("sorts Babylon.js keys by frame and reports the highest frame", () => {
        const anim = new Animation("a", "position.x", 60);
        const keys = [
            { frame: 30, value: 5 },
            { frame: 0, value: 0 },
        ];
        anim.setKeys(keys);
        expect(anim.getKeys()).not.toBe(keys);
        expect(anim.getKeys().map((key) => key.frame)).toEqual([0, 30]);
        expect(anim.getHighestFrame()).toBe(30);
    });

    it("honors Babylon.js setKeys clone controls", () => {
        const anim = new Animation("a", "position", 60, Animation.ANIMATIONTYPE_VECTOR3);
        const value = new Vector3(1, 2, 3);
        const keys = [{ frame: 0, value }];
        anim.setKeys(keys, false, true);
        expect(anim.getKeys()[0]).not.toBe(keys[0]);
        expect(anim.getKeys()[0]!.value).not.toBe(value);
        const arrayValue = [1, 2, 3];
        anim.setKeys([{ frame: 0, value: arrayValue }], false, true);
        expect(anim.getKeys()[0]!.value).toBe(arrayValue);
        anim.setKeys(keys, true);
        expect(anim.getKeys()).toBe(keys);
    });

    it("evaluates float keys with linear interpolation and clamping", () => {
        const anim = new Animation("a", "position.x", 60);
        anim.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        expect(anim.evaluate(-5)).toBe(0);
        expect(anim.evaluate(5)).toBe(5);
        expect(anim.evaluate(10)).toBe(10);
        expect(anim.evaluate(20)).toBe(10);
    });

    it("evaluates vector (array) keys componentwise", () => {
        const anim = new Animation("a", "position", 60, Animation.ANIMATIONTYPE_VECTOR3);
        anim.setKeys([
            { frame: 0, value: [0, 0, 0] },
            { frame: 10, value: [10, 20, 30] },
        ]);
        expect(anim.evaluate(5)).toEqual([5, 10, 15]);
    });

    it("stores and applies a structural animation-level easing function with Babylon.js null semantics", () => {
        const anim = new Animation("a", "position.x", 60);
        const easing: IEasingFunction = { ease: (gradient) => gradient * gradient };
        expect(anim.getEasingFunction()).toBeNull();
        expect(anim.setEasingFunction(easing)).toBeUndefined();
        anim.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);

        expect(anim.getEasingFunction()).toBe(easing);
        expect(anim.evaluate(5)).toBeCloseTo(2.5);
        anim.setEasingFunction(null);
        expect(anim.getEasingFunction()).toBeNull();
        expect(anim.evaluate(5)).toBeCloseTo(5);
    });

    it("uses each start-key easing before the animation default or linear progress", () => {
        const anim = new Animation("perKey", "x", 10);
        const firstEasing = new QuadraticEase();
        const unusedEasing = { ease: vi.fn(() => 0) };
        const keys: IAnimationKey[] = [
            { frame: 0, value: 0, easingFunction: firstEasing },
            { frame: 10, value: 10 },
            { frame: 20, value: 20, easingFunction: { ease: (gradient) => gradient ** 3 } },
            { frame: 30, value: 30, easingFunction: unusedEasing },
        ];
        anim.setKeys(keys);
        anim.setEasingFunction({ ease: (gradient) => Math.sqrt(gradient) });

        expect(anim.getKeys()[0]!.easingFunction).toBe(firstEasing);
        expect(anim.evaluate(5)).toBeCloseTo(2.5);
        expect(anim.evaluate(15)).toBeCloseTo(10 + 10 * Math.sqrt(0.5));
        expect(anim.evaluate(25)).toBeCloseTo(21.25);
        anim.setEasingFunction(null);
        expect(anim.evaluate(5)).toBeCloseTo(2.5);
        expect(anim.evaluate(15)).toBe(15);
        expect(anim.evaluate(25)).toBeCloseTo(21.25);
        expect(anim.evaluate(30)).toBe(30);
        expect(unusedEasing.ease).not.toHaveBeenCalled();
    });

    it("applies per-key vector overshoot while keeping clamped endpoints exact", () => {
        const anim = new Animation("perKeyVector", "position", 10, Animation.ANIMATIONTYPE_VECTOR3);
        const easing = { ease: vi.fn(() => 1.25) };
        const start = new Vector3(0, 0, 0);
        const end = new Vector3(4, 8, 12);
        anim.setKeys([
            { frame: 0, value: start, easingFunction: easing },
            { frame: 10, value: end },
        ]);

        expect(anim.evaluate(-5)).toBe(start);
        expect(anim.evaluate(0)).toBe(start);
        expect(anim.evaluate(10)).toBe(end);
        expect(anim.evaluate(15)).toBe(end);
        expect(easing.ease).not.toHaveBeenCalled();
        expect((anim.evaluate(5) as Vector3).asArray()).toEqual([5, 10, 15]);
        expect(easing.ease).toHaveBeenCalledExactlyOnceWith(0.5);
    });

    it("uses per-key easing for quaternion slerp without clamping overshoot", () => {
        const anim = new Animation("perKeyQuaternion", "rotationQuaternion", 10, Animation.ANIMATIONTYPE_QUATERNION);
        anim.setKeys([
            { frame: 0, value: new Quaternion(0, 0, 0, 1), easingFunction: { ease: () => 1.25 } },
            { frame: 10, value: new Quaternion(0, 1, 0, 0) },
        ]);

        const value = anim.evaluate(5) as Quaternion;
        expect(value.y).toBeCloseTo(Math.sin((5 * Math.PI) / 8));
        expect(value.w).toBeCloseTo(Math.cos((5 * Math.PI) / 8));
    });

    it("bypasses per-key easing on STEP segments and advances at the next key", () => {
        const anim = new Animation("perKeyStep", "x", 10);
        const ignored = { ease: vi.fn(() => 0.75) };
        anim.setKeys([
            { frame: 0, value: 0, interpolation: AnimationKeyInterpolation.STEP, easingFunction: ignored },
            { frame: 10, value: 10, easingFunction: new QuadraticEase() },
            { frame: 20, value: 20 },
        ]);

        expect(anim.evaluate(5)).toBe(0);
        expect(anim.evaluate(10)).toBe(10);
        expect(anim.evaluate(15)).toBeCloseTo(12.5);
        expect(ignored.ease).not.toHaveBeenCalled();
    });

    it("applies easing to vector values while preserving exact endpoints and overshoot", () => {
        const anim = new Animation("a", "position", 60, Animation.ANIMATIONTYPE_VECTOR3);
        const easing = { ease: vi.fn((gradient: number) => (gradient === 0.5 ? 1.25 : 0.75)) };
        anim.setEasingFunction(easing);
        const start = new Vector3(0, 0, 0);
        const end = new Vector3(4, 8, 12);
        anim.setKeys([
            { frame: 0, value: start },
            { frame: 10, value: end },
        ]);

        expect(anim.evaluate(0)).toBe(start);
        expect(anim.evaluate(10)).toBe(end);
        expect(easing.ease).not.toHaveBeenCalled();
        expect((anim.evaluate(5) as Vector3).asArray()).toEqual([5, 10, 15]);
        expect(easing.ease).toHaveBeenCalledOnce();
    });

    it("matches Babylon.js quaternion slerp for near-parallel overshoot", () => {
        const anim = new Animation("a", "rotationQuaternion", 60, Animation.ANIMATIONTYPE_QUATERNION);
        anim.setEasingFunction({ ease: () => 1.25 });
        anim.setKeys([
            { frame: 0, value: [0, 0, 0, 1] },
            { frame: 10, value: [0, 0, 0.015, Math.sqrt(1 - 0.015 * 0.015)] },
        ]);

        const value = anim.evaluate(5) as number[];
        expect(value[2]).toBeCloseTo(0.018749604459090463, 12);
        expect(value[3]).toBeCloseTo(0.9998242107153774, 12);
    });

    it("bypasses easing for STEP segments", () => {
        const anim = new Animation("a", "position.x", 10);
        const easing = { ease: vi.fn(() => 0.75) };
        anim.setEasingFunction(easing);
        anim.setKeys([
            { frame: 0, value: -1.5, interpolation: AnimationKeyInterpolation.STEP },
            { frame: 10, value: 1.5 },
        ]);

        expect(anim.evaluate(5)).toBe(-1.5);
        expect(easing.ease).not.toHaveBeenCalled();
    });

    it("builds a one-shot animation via CreateAndStartAnimation", () => {
        const anim = Animation.CreateAndStartAnimation("spin", {}, "rotation.y", 60, 60, 0, Math.PI);
        expect(anim.getHighestFrame()).toBe(60);
        expect(anim.evaluate(60)).toBeCloseTo(Math.PI, 6);
    });

    it("holds the start-key value across a STEP-interpolated segment", () => {
        expect(AnimationKeyInterpolation.STEP).toBe(1);
        const anim = new Animation("a", "position.x", 10);
        anim.setKeys([
            { frame: 0, value: -1.5, interpolation: AnimationKeyInterpolation.STEP },
            { frame: 10, value: 1.5, interpolation: AnimationKeyInterpolation.STEP },
            { frame: 20, value: -1.5, interpolation: AnimationKeyInterpolation.STEP },
        ]);
        // Within a STEP segment the value is held at the start key (no lerp)…
        expect(anim.evaluate(5)).toBe(-1.5);
        expect(anim.evaluate(9.9)).toBe(-1.5);
        // …and only changes when the next key is reached.
        expect(anim.evaluate(10)).toBe(1.5);
        expect(anim.evaluate(15)).toBe(1.5);
    });
});

describe("AnimationGroup", () => {
    it("tracks targeted animations and playback state", () => {
        const group = new AnimationGroup("group");
        const anim = new Animation("a", "position.x", 60);
        anim.setKeys([
            { frame: 0, value: 0 },
            { frame: 40, value: 1 },
        ]);
        group.addTargetedAnimation(anim, {});
        expect(group.to).toBe(40);
        expect(group.isPlaying).toBe(false);
        group.play();
        expect(group.isPlaying).toBe(true);
        expect(group.state).toBe("playing");
        group.pause();
        expect(group.state).toBe("paused");
        group.stop();
        expect(group.state).toBe("stopped");
    });

    it("adapts loaded Lite tracks and forwards setKeys back to the sampler", () => {
        const target = {};
        const sampler = {
            input: new Float32Array([0, 1]),
            output: new Float32Array([0, 0, 0, 1, 2, 3]),
            interpolation: INTERP_LINEAR,
        };
        const lite = {
            name: "loaded",
            duration: 1,
            frameRate: 60,
            isPlaying: false,
            currentTime: 0,
            targetedAnimations: [{ target, path: "translation" }],
            speedRatio: 1,
            loopAnimation: true,
            weight: 1,
            _stopped: false,
            _propertyMixer: [
                [
                    {
                        sampler,
                        stride: 3,
                        quaternion: false,
                        writer: () => undefined,
                        mixTarget: () => target,
                        mixProperty: "position",
                    },
                ],
                60,
                0,
                1,
            ],
        } as unknown as LiteAnimationGroup;
        const wrappedTarget = {};
        const group = AnimationGroup._fromLite(lite, {} as never, undefined, () => [wrappedTarget]);

        expect(group.targetedAnimations).toHaveLength(1);
        const targeted = group.targetedAnimations[0]!;
        expect(targeted.getClassName()).toBe("TargetedAnimation");
        expect(targeted.parent).toBe(group);
        expect(targeted.target).toBe(wrappedTarget);
        expect(targeted.animation.targetProperty).toBe("translation");
        expect((targeted.animation.getKeys()[1]!.value as Vector3).asArray()).toEqual([1, 2, 3]);

        targeted.animation.setKeys([
            { frame: 0, value: new Vector3(3, 2, 1) },
            { frame: 60, value: new Vector3(6, 5, 4) },
        ]);

        expect(Array.from(sampler.output)).toEqual([0, 0, 0, 1, 2, 3]);
        expect(targeted.animation.getKeys().map((key) => animationComponentsForTest(key.value))).toEqual([
            [3, 2, 1],
            [6, 5, 4],
        ]);
        expect((targeted.animation.evaluate(60) as Vector3).asArray()).toEqual([6, 5, 4]);
        const retained = [
            { frame: 60, value: new Vector3(9, 8, 7) },
            { frame: 0, value: new Vector3(3, 2, 1) },
        ];
        targeted.animation.setKeys(retained, true);
        expect(retained.map((key) => key.frame)).toEqual([60, 0]);
        retained[0]!.value = new Vector3(100, 100, 100);
        targeted.animation.getKeys()[0]!.value = new Vector3(200, 200, 200);
        expect(targeted.animation.getKeys().map((key) => animationComponentsForTest(key.value))).toEqual([
            [3, 2, 1],
            [9, 8, 7],
        ]);
        expect((targeted.animation.evaluate(60) as Vector3).asArray()).toEqual([9, 8, 7]);
        const editedKeys = targeted.animation.getKeys();
        expect(() =>
            targeted.animation.setKeys([
                { frame: 0, value: new Vector3(3, 2, 1), inTangent: new Vector3(0, 0, 0), outTangent: new Vector3(0, 0, 0) },
                { frame: 60, value: new Vector3(6, 5, 4), inTangent: new Vector3(0, 0, 0), outTangent: new Vector3(0, 0, 0) },
            ])
        ).toThrow(/cannot add tangents/);
        expect(targeted.animation.getKeys()).toEqual(editedKeys);
    });

    it("evaluates loaded cubic tracks with Lite Hermite interpolation", () => {
        const sampler = {
            input: new Float32Array([0, 1]),
            output: new Float32Array([0, 0, 2, 0, 1, 0]),
            interpolation: INTERP_CUBICSPLINE,
        };
        const lite = {
            name: "cubic",
            duration: 1,
            frameRate: 60,
            isPlaying: false,
            currentTime: 0,
            targetedAnimations: [{ target: {}, path: "value" }],
            speedRatio: 1,
            loopAnimation: true,
            weight: 1,
            _stopped: false,
            _gltfMixer: [{ name: "cubic", duration: 1, frameRate: 60, samplers: [sampler], channels: [{ samplerIdx: 0, nodeIdx: 0, path: PATH_WEIGHTS }] }, [], []],
        } as unknown as LiteAnimationGroup;
        const animation = AnimationGroup._fromLite(lite, {} as never).targetedAnimations[0]!.animation;

        expect(animation.evaluate(30)).toBeCloseTo(0.75);
    });

    it("surfaces property-track easing and evaluates through Lite", () => {
        const easing = (gradient: number) => gradient * gradient;
        const lite = {
            name: "eased",
            duration: 1,
            frameRate: 60,
            isPlaying: false,
            currentTime: 0,
            targetedAnimations: [{ target: {}, path: "value" }],
            speedRatio: 1,
            loopAnimation: true,
            weight: 1,
            _stopped: false,
            _propertyMixer: [
                [{ sampler: { input: new Float32Array([0, 1]), output: new Float32Array([0, 8]), interpolation: INTERP_LINEAR }, stride: 1, quaternion: false, easing }],
                60,
                0,
                1,
            ],
        } as unknown as LiteAnimationGroup;
        const animation = AnimationGroup._fromLite(lite, {} as never).targetedAnimations[0]!.animation;

        expect(animation.getEasingFunction()!.ease).toBe(easing);
        expect(animation.evaluate(30)).toBeCloseTo(2);
        expect(() => animation.setEasingFunction({ ease: (gradient) => gradient })).toThrow(/Lite runtime-track easing setter/);
        expect(animation.getEasingFunction()!.ease).toBe(easing);
    });

    it("keeps colliding manual property names out of glTF path translation", () => {
        const target = { weights: 0, pointer: 0 };
        const lite = {
            name: "manual",
            duration: 1,
            frameRate: 60,
            isPlaying: false,
            currentTime: 0,
            targetedAnimations: [
                { target, path: "weights" },
                { target, path: "pointer" },
            ],
            speedRatio: 1,
            loopAnimation: true,
            weight: 1,
            _stopped: false,
            _propertyMixer: [
                [
                    { sampler: { input: new Float32Array([0, 1]), output: new Float32Array([0, 1]), interpolation: INTERP_LINEAR }, stride: 1, quaternion: false },
                    { sampler: { input: new Float32Array([0, 1]), output: new Float32Array([0, 2]), interpolation: INTERP_LINEAR }, stride: 1, quaternion: false },
                ],
                60,
                0,
                1,
            ],
        } as unknown as LiteAnimationGroup;

        const animations = AnimationGroup._fromLite(lite, {} as never).targetedAnimations.map((targeted) => targeted.animation);
        expect(animations.map((animation) => animation.targetProperty)).toEqual(["weights", "pointer"]);
        animations[0]!.setKeys([
            { frame: 60, value: 3 },
            { frame: 0, value: 1 },
        ]);
        expect(animations[0]!.evaluate(30)).toBe(2);
    });

    it("rejects loaded per-key easing without mutating snapshots", () => {
        const lite = {
            name: "loaded",
            duration: 1,
            frameRate: 60,
            isPlaying: false,
            currentTime: 0,
            targetedAnimations: [{ target: {}, path: "value" }],
            speedRatio: 1,
            loopAnimation: true,
            weight: 1,
            _stopped: false,
            _propertyMixer: [
                [{ sampler: { input: new Float32Array([0, 1]), output: new Float32Array([0, 1]), interpolation: INTERP_LINEAR }, stride: 1, quaternion: false }],
                60,
                0,
                1,
            ],
        } as unknown as LiteAnimationGroup;
        const animation = AnimationGroup._fromLite(lite, {} as never).targetedAnimations[0]!.animation;
        const before = animation.getKeys();

        expect(() =>
            animation.setKeys([
                { frame: 0, value: 0, easingFunction: { ease: (gradient) => gradient } },
                { frame: 60, value: 1 },
            ])
        ).toThrow(/per-key easing/);
        expect(animation.getKeys()).toEqual(before);
    });

    it("rejects tangent-mode changes and shared glTF samplers without mutating keys", () => {
        const sampler = { input: new Float32Array([0, 1]), output: new Float32Array([0, 1]), interpolation: INTERP_LINEAR };
        const lite = {
            name: "shared",
            duration: 1,
            frameRate: 60,
            isPlaying: false,
            currentTime: 0,
            targetedAnimations: [
                { target: {}, path: "value" },
                { target: {}, path: "value" },
            ],
            speedRatio: 1,
            loopAnimation: true,
            weight: 1,
            _stopped: false,
            _gltfMixer: [
                {
                    name: "shared",
                    duration: 1,
                    frameRate: 60,
                    samplers: [sampler],
                    channels: [
                        { samplerIdx: 0, nodeIdx: 0, path: PATH_WEIGHTS },
                        { samplerIdx: 0, nodeIdx: 0, path: PATH_WEIGHTS },
                    ],
                },
                [],
                [],
            ],
        } as unknown as LiteAnimationGroup;
        const animation = AnimationGroup._fromLite(lite, {} as never).targetedAnimations[0]!.animation;
        const originalKeys = animation.getKeys();

        expect(() => animation.setKeys([{ frame: 0, value: 0, inTangent: 0, outTangent: 0 }])).toThrow(/referenced by multiple channels/);
        expect(animation.getKeys()).toEqual(originalKeys);
        expect(Array.from(sampler.output)).toEqual([0, 1]);
    });

    it("rejects missing cubic tangents with a named interpolation blocker", () => {
        const sampler = { input: new Float32Array([0, 1]), output: new Float32Array([0, 0, 1, 0, 1, 0]), interpolation: INTERP_CUBICSPLINE };
        const lite = {
            name: "cubic",
            duration: 1,
            frameRate: 60,
            isPlaying: false,
            currentTime: 0,
            targetedAnimations: [{ target: {}, path: "value" }],
            speedRatio: 1,
            loopAnimation: true,
            weight: 1,
            _stopped: false,
            _gltfMixer: [{ name: "cubic", duration: 1, frameRate: 60, samplers: [sampler], channels: [{ samplerIdx: 0, nodeIdx: 0, path: PATH_WEIGHTS }] }, [], []],
        } as unknown as LiteAnimationGroup;
        const animation = AnimationGroup._fromLite(lite, {} as never).targetedAnimations[0]!.animation;

        expect(() => animation.setKeys([{ frame: 0, value: 0 }])).toThrow(/must preserve both tangents/);
    });

    it("does not reorder a retained loaded draft when cubic validation fails", () => {
        const sampler = { input: new Float32Array([0, 1]), output: new Float32Array([0, 0, 1, 0, 1, 0]), interpolation: INTERP_CUBICSPLINE };
        const lite = {
            name: "cubic",
            duration: 1,
            frameRate: 60,
            isPlaying: false,
            currentTime: 0,
            targetedAnimations: [{ target: {}, path: "value" }],
            speedRatio: 1,
            loopAnimation: true,
            weight: 1,
            _stopped: false,
            _gltfMixer: [{ name: "cubic", duration: 1, frameRate: 60, samplers: [sampler], channels: [{ samplerIdx: 0, nodeIdx: 0, path: PATH_WEIGHTS }] }, [], []],
        } as unknown as LiteAnimationGroup;
        const animation = AnimationGroup._fromLite(lite, {} as never).targetedAnimations[0]!.animation;
        const draft = [
            { frame: 60, value: 1 },
            { frame: 0, value: 0 },
        ];

        expect(() => animation.setKeys(draft, true)).toThrow(/must preserve both tangents/);
        expect(draft.map((key) => key.frame)).toEqual([60, 0]);
    });

    it("preserves locked tangent metadata after committing loaded cubic keys", () => {
        const sampler = { input: new Float32Array([0, 1]), output: new Float32Array([0, 0, 1, 0, 1, 0]), interpolation: INTERP_CUBICSPLINE };
        const lite = {
            name: "cubic",
            duration: 1,
            frameRate: 60,
            isPlaying: false,
            currentTime: 0,
            targetedAnimations: [{ target: {}, path: "value" }],
            speedRatio: 1,
            loopAnimation: true,
            weight: 1,
            _stopped: false,
            _gltfMixer: [{ name: "cubic", duration: 1, frameRate: 60, samplers: [sampler], channels: [{ samplerIdx: 0, nodeIdx: 0, path: PATH_WEIGHTS }] }, [], []],
        } as unknown as LiteAnimationGroup;
        const animation = AnimationGroup._fromLite(lite, {} as never).targetedAnimations[0]!.animation;

        animation.setKeys([
            { frame: 0, value: 0, inTangent: 0, outTangent: 1, lockedTangent: true },
            { frame: 60, value: 1, inTangent: 1, outTangent: 0, lockedTangent: false },
        ]);

        expect(animation.getKeys().map((key) => key.lockedTangent)).toEqual([true, false]);
    });

    it("keeps wrapper keys and the Lite sampler unchanged when a loaded edit is rejected", () => {
        const sampler = {
            input: new Float32Array([0, 1]),
            output: new Float32Array([0, 1]),
            interpolation: INTERP_STEP,
        };
        const lite = {
            name: "step",
            duration: 1,
            frameRate: 60,
            isPlaying: false,
            currentTime: 0,
            targetedAnimations: [{ target: {}, path: "value" }],
            speedRatio: 1,
            loopAnimation: true,
            weight: 1,
            _stopped: false,
            _propertyMixer: [[{ sampler, stride: 1, quaternion: false, writer: () => undefined, mixTarget: () => ({}), mixProperty: "value" }], 60, 0, 1],
        } as unknown as LiteAnimationGroup;
        const animation = AnimationGroup._fromLite(lite, {} as never).targetedAnimations[0]!.animation;
        const originalKeys = animation.getKeys();

        expect(() =>
            animation.setKeys([
                { frame: 0, value: 2 },
                { frame: 60, value: 3 },
            ])
        ).toThrow(/preserve STEP interpolation/);
        expect(animation.getKeys()).toEqual(originalKeys);
        expect(Array.from(sampler.output)).toEqual([0, 1]);
    });

    it("adapts single-primitive morph components and rejects shared multi-primitive samplers", () => {
        const sampler = {
            input: new Float32Array([0, 1]),
            output: new Float32Array([0, 0, 1, 1]),
            interpolation: INTERP_LINEAR,
        };
        const lite = {
            name: "morph",
            duration: 1,
            frameRate: 60,
            isPlaying: false,
            currentTime: 0,
            targetedAnimations: [{ target: {}, path: "weights" }],
            speedRatio: 1,
            loopAnimation: true,
            weight: 1,
            _stopped: false,
            _gltfMixer: [{ name: "morph", duration: 1, frameRate: 60, samplers: [sampler], channels: [{ samplerIdx: 0, nodeIdx: 0, path: PATH_WEIGHTS }] }, [], []],
        } as unknown as LiteAnimationGroup;
        const targets = [{ influence: 0 }, { influence: 0 }];
        const group = AnimationGroup._fromLite(lite, {} as never, undefined, (_target, path, componentIndex) => {
            expect(path).toBe("weights");
            return [targets[componentIndex!]!];
        });

        expect(group.targetedAnimations.map((targeted) => targeted.target)).toEqual(targets);
        expect(group.targetedAnimations.map((targeted) => targeted.animation.targetProperty)).toEqual(["influence", "influence"]);

        const multiPrimitive = AnimationGroup._fromLite(lite, {} as never, undefined, (_target, _path, componentIndex) => [
            { componentIndex, primitive: 0 },
            { componentIndex, primitive: 1 },
        ]);
        expect(() => multiPrimitive.targetedAnimations).toThrow(/independently editable Animation objects per primitive/);
        expect(() => multiPrimitive.targetedAnimations).toThrow(/independently editable Animation objects per primitive/);
    });

    it("retries unsupported pointer-track adaptation without returning partial state", () => {
        const sampler = { input: new Float32Array([0]), output: new Float32Array([1]), interpolation: INTERP_LINEAR };
        const lite = {
            name: "pointer",
            duration: 0,
            frameRate: 60,
            isPlaying: false,
            currentTime: 0,
            targetedAnimations: [{ path: "pointer" }],
            speedRatio: 1,
            loopAnimation: true,
            weight: 1,
            _stopped: false,
            _gltfMixer: [{ name: "pointer", duration: 0, frameRate: 60, samplers: [sampler], channels: [{ samplerIdx: 0, nodeIdx: -1, path: PATH_POINTER }] }, [], []],
        } as unknown as LiteAnimationGroup;
        const group = AnimationGroup._fromLite(lite, {} as never);

        expect(() => group.targetedAnimations).toThrow(/exact property path/);
        expect(() => group.targetedAnimations).toThrow(/exact property path/);
    });
});

function animationComponentsForTest(value: IAnimationKey["value"]): number[] {
    return typeof value === "number" ? [value] : Array.isArray(value) ? value : value.asArray();
}

describe("AnimationGroup structural weighted blending", () => {
    class TestHost {
        public readonly groups: AnimationGroup[] = [];
        public _registerStructuralGroup(group: AnimationGroup): void {
            if (!this.groups.includes(group)) {
                this.groups.push(group);
            }
        }
        public _recomputeStructuralBlends(): void {
            AnimationGroup._blendStructuralGroups(this.groups);
        }
    }

    function slide(name: string, peak: number): Animation {
        const anim = new Animation(name, "position.x", 10);
        anim.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: peak },
            { frame: 20, value: 0 },
        ]);
        return anim;
    }

    it("blends two groups by weight into the same property (scene 155)", () => {
        const host = new TestHost();
        const box = { position: { x: 0 } };

        const positive = new AnimationGroup("weightedPositive", host);
        positive.addTargetedAnimation(slide("pos", 2), box);
        positive.weight = 0.25;
        positive.start(true, 1, 0, 20);

        const negative = new AnimationGroup("weightedNegative", host);
        negative.addTargetedAnimation(slide("neg", -2), box);
        negative.weight = 0.75;
        negative.start(true, 1, 0, 20);

        positive.goToFrame(10);
        negative.goToFrame(10);

        // 2 * 0.25 + (-2) * 0.75 = -1
        expect(box.position.x).toBeCloseTo(-1, 6);
    });

    it("cross-fades by re-weighting at a fractional frame (scene 156)", () => {
        const host = new TestHost();
        const box = { position: { x: 0 } };

        const positive = new AnimationGroup("crossFadePositive", host);
        positive.addTargetedAnimation(slide("pos", 2), box);
        positive.weight = 1;
        positive.start(true, 1, 0, 20);

        const negative = new AnimationGroup("crossFadeNegative", host);
        negative.addTargetedAnimation(slide("neg", -2), box);
        negative.weight = 0;
        negative.start(true, 1, 0, 20);

        // seekTime 1.25 → frame 12.5, fadeT 0.25 → weights 0.75 / 0.25
        positive.weight = 0.75;
        negative.weight = 0.25;
        positive.goToFrame(12.5);
        negative.goToFrame(12.5);

        // pos@12.5 = 1.5, neg@12.5 = -1.5 → 1.5 * 0.75 + (-1.5) * 0.25 = 0.75
        expect(box.position.x).toBeCloseTo(0.75, 6);
    });

    it("falls back to the rest pose when total weight is below 1", () => {
        const host = new TestHost();
        const box = { position: { x: 0 } };

        const positive = new AnimationGroup("partial", host);
        positive.addTargetedAnimation(slide("pos", 2), box);
        positive.weight = 0.5;
        positive.start(true, 1, 0, 20);
        positive.goToFrame(10);

        // total weight 0.5 < 1 → 0 * 0.5 (original) + 2 * 0.5 = 1
        expect(box.position.x).toBeCloseTo(1, 6);
    });

    it("keeps structural vector and quaternion rest poses stable across repeated blends", () => {
        const host = new TestHost();
        const target = { position: new Vector3(0, 0, 0), rotationQuaternion: new Quaternion(0, 0, 0, 1) };
        const position = new Animation("position", "position", 10, Animation.ANIMATIONTYPE_VECTOR3);
        position.setKeys([
            { frame: 0, value: new Vector3(0, 0, 0) },
            { frame: 10, value: new Vector3(10, 0, 0) },
        ]);
        const rotation = new Animation("rotation", "rotationQuaternion", 10, Animation.ANIMATIONTYPE_QUATERNION);
        rotation.setKeys([
            { frame: 0, value: new Quaternion(0, 0, 0, 1) },
            { frame: 10, value: new Quaternion(0, 0, 1, 0) },
        ]);
        const group = new AnimationGroup("stableRestPose", host);
        group.addTargetedAnimation(position, target);
        group.addTargetedAnimation(rotation, target);
        group.weight = 0.5;
        group.start(false, 1, 0, 10);

        group.goToFrame(10);
        expect(target.position.asArray()).toEqual([5, 0, 0]);
        expect(target.rotationQuaternion.asArray()).toEqual([0, 0, 0.5, 0.5]);

        group.goToFrame(10);
        expect(target.position.asArray()).toEqual([5, 0, 0]);
        expect(target.rotationQuaternion.asArray()).toEqual([0, 0, 0.5, 0.5]);
    });

    it("uses per-key easing while evaluating structural groups", () => {
        const host = new TestHost();
        const box = { position: { x: 0 } };
        const eased = slide("perKey", 4);
        eased.getKeys()[0]!.easingFunction = new QuadraticEase();
        eased.setEasingFunction({ ease: () => 0.75 });
        const group = new AnimationGroup("perKeyStructural", host);
        group.addTargetedAnimation(eased, box);
        group.start(false, 1, 0, 20);

        group.goToFrame(5);
        expect(box.position.x).toBeCloseTo(1);
        group.goToFrame(15);
        expect(box.position.x).toBeCloseTo(1);
    });

    it("uses animation-level easing while evaluating structural groups", () => {
        const host = new TestHost();
        const box = { position: { x: 0 } };
        const eased = slide("eased", 4);
        eased.setEasingFunction(new QuadraticEase());
        const group = new AnimationGroup("structuralEasing", host);
        group.addTargetedAnimation(eased, box);
        group.start(false, 1, 0, 20);

        group.goToFrame(5);

        expect(box.position.x).toBeCloseTo(1);
    });
});
