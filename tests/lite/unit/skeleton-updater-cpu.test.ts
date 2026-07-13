import { describe, expect, it, vi } from "vitest";

import { PATH_TRANSLATION } from "../../../packages/babylon-lite/src/animation/types";
import type { AnimationClip, NodeRest, SkeletonBinding } from "../../../packages/babylon-lite/src/animation/types";
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
});
