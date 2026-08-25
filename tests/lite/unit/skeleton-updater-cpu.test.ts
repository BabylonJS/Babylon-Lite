import { describe, expect, it, vi } from "vitest";

import { PATH_TRANSLATION, PATH_WEIGHTS } from "../../../packages/babylon-lite/src/animation/types";
import type { AnimationClip, MorphBinding, MorphTargetData, NodeRest, SkeletonBinding, SkeletonData } from "../../../packages/babylon-lite/src/animation/types";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import { createAnimationController } from "../../../packages/babylon-lite/src/skeleton/skeleton-updater";

function identity(): Float32Array {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

describe("CPU-only skeleton evaluation", () => {
    it("updates bone matrices without submitting a bone texture upload", () => {
        const boneMatrices = new Float32Array(16);
        const binding: SkeletonBinding = {
            jointNodes: [0],
            inverseBindMatrices: identity(),
            invMeshWorld: identity() as unknown as Mat4,
            boneTexture: {} as GPUTexture,
            boneCount: 1,
            boneMatrices,
        };
        const nodes: NodeRest[] = [
            {
                parentIdx: -1,
                tx: 0,
                ty: 0,
                tz: 0,
                rx: 0,
                ry: 0,
                rz: 0,
                rw: 1,
                sx: 1,
                sy: 1,
                sz: 1,
            },
        ];
        const clip: AnimationClip = {
            name: "move",
            duration: 1,
            channels: [{ samplerIdx: 0, nodeIdx: 0, path: PATH_TRANSLATION }],
            samplers: [
                {
                    input: new Float32Array([0, 1]),
                    output: new Float32Array([0, 0, 0, 2, 0, 0]),
                    interpolation: 0,
                },
            ],
        };
        const writeTexture = vi.fn();
        const engine = { _device: { queue: { writeTexture } } } as unknown as EngineContext;
        const ctrl = createAnimationController(clip, nodes, [binding], []);
        ctrl.playing = false;
        ctrl.loop = false;
        ctrl.time = 1;

        ctrl._tickCpu!(0);

        expect(boneMatrices[12]).toBeCloseTo(-2);
        expect(writeTexture).not.toHaveBeenCalled();

        ctrl.tick(0, engine);
        expect(writeTexture).toHaveBeenCalledTimes(1);
    });

    it("does not overwrite a skeleton that the clip does not target", () => {
        const firstBoneMatrices = new Float32Array(16);
        const secondBoneMatrices = new Float32Array(16);
        const firstTexture = {} as GPUTexture;
        const secondTexture = {} as GPUTexture;
        const bindings: SkeletonBinding[] = [
            {
                jointNodes: [0],
                inverseBindMatrices: identity(),
                invMeshWorld: identity() as unknown as Mat4,
                boneTexture: firstTexture,
                boneCount: 1,
                boneMatrices: firstBoneMatrices,
            },
            {
                jointNodes: [1],
                inverseBindMatrices: identity(),
                invMeshWorld: identity() as unknown as Mat4,
                boneTexture: secondTexture,
                boneCount: 1,
                boneMatrices: secondBoneMatrices,
            },
        ];
        const nodes: NodeRest[] = [
            {
                parentIdx: -1,
                tx: 0,
                ty: 0,
                tz: 0,
                rx: 0,
                ry: 0,
                rz: 0,
                rw: 1,
                sx: 1,
                sy: 1,
                sz: 1,
            },
            {
                parentIdx: -1,
                tx: 0,
                ty: 0,
                tz: 0,
                rx: 0,
                ry: 0,
                rz: 0,
                rw: 1,
                sx: 1,
                sy: 1,
                sz: 1,
            },
        ];
        const clip: AnimationClip = {
            name: "first-only",
            duration: 1,
            channels: [{ samplerIdx: 0, nodeIdx: 0, path: PATH_TRANSLATION }],
            samplers: [
                {
                    input: new Float32Array([0, 1]),
                    output: new Float32Array([0, 0, 0, 2, 0, 0]),
                    interpolation: 0,
                },
            ],
        };
        const writeTexture = vi.fn();
        const engine = { _device: { queue: { writeTexture } } } as unknown as EngineContext;
        const ctrl = createAnimationController(clip, nodes, bindings, []);
        ctrl.playing = false;
        ctrl.loop = false;
        ctrl.time = 1;

        ctrl.tick(0, engine);

        expect(firstBoneMatrices[12]).toBeCloseTo(-2);
        expect(secondBoneMatrices).toEqual(new Float32Array(16));
        expect(writeTexture).toHaveBeenCalledTimes(1);
        expect(writeTexture.mock.calls[0]![0]).toEqual({ texture: firstTexture });
    });

    it("does not upload to a skeleton released by its last mesh owner", () => {
        const boneMatrices = new Float32Array(16);
        const runtimeSkeleton = { boneTexture: {} as GPUTexture, boneMatrices, _disposed: true } as SkeletonData;
        const binding: SkeletonBinding = {
            jointNodes: [0],
            inverseBindMatrices: identity(),
            invMeshWorld: identity() as unknown as Mat4,
            boneTexture: runtimeSkeleton.boneTexture,
            boneCount: 1,
            boneMatrices,
            runtimeSkeleton,
        };
        const nodes: NodeRest[] = [
            {
                parentIdx: -1,
                tx: 0,
                ty: 0,
                tz: 0,
                rx: 0,
                ry: 0,
                rz: 0,
                rw: 1,
                sx: 1,
                sy: 1,
                sz: 1,
            },
        ];
        const clip: AnimationClip = {
            name: "move",
            duration: 1,
            channels: [{ samplerIdx: 0, nodeIdx: 0, path: PATH_TRANSLATION }],
            samplers: [
                {
                    input: new Float32Array([0, 1]),
                    output: new Float32Array([0, 0, 0, 2, 0, 0]),
                    interpolation: 0,
                },
            ],
        };
        const writeTexture = vi.fn();
        const engine = { _device: { queue: { writeTexture } } } as unknown as EngineContext;
        const ctrl = createAnimationController(clip, nodes, [binding], []);
        ctrl.playing = false;
        ctrl.loop = false;
        ctrl.time = 1;

        ctrl.tick(0, engine);

        expect(boneMatrices[12]).toBeCloseTo(-2);
        expect(writeTexture).not.toHaveBeenCalled();
    });

    it("does not upload morph weights after their last mesh owner releases them", () => {
        const runtimeMorphTargets = {
            weightsBuffer: {} as GPUBuffer,
            weights: new Float32Array(1),
            _disposed: true,
        } as MorphTargetData;
        const binding: MorphBinding = {
            nodeIdx: 0,
            weightsBuffer: runtimeMorphTargets.weightsBuffer,
            weights: runtimeMorphTargets.weights,
            targetCount: 1,
            runtimeMorphTargets,
        };
        const clip: AnimationClip = {
            name: "morph",
            duration: 1,
            channels: [{ samplerIdx: 0, nodeIdx: 0, path: PATH_WEIGHTS }],
            samplers: [
                {
                    input: new Float32Array([0, 1]),
                    output: new Float32Array([0, 1]),
                    interpolation: 0,
                },
            ],
        };
        const writeBuffer = vi.fn();
        const engine = { _device: { queue: { writeBuffer } } } as unknown as EngineContext;
        const ctrl = createAnimationController(clip, [], [], [binding]);
        ctrl.playing = false;
        ctrl.loop = false;
        ctrl.time = 1;

        ctrl.tick(0, engine);

        expect(binding.weights[0]).toBe(1);
        expect(writeBuffer).not.toHaveBeenCalled();
    });
});
