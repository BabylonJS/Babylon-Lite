import { describe, expect, it, vi } from "vitest";

import type { SkeletonData } from "../../../packages/babylon-lite/src/animation/types";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { updateSkeletonBoneMatrices } from "../../../packages/babylon-lite/src/skeleton/update-skeleton-bone-matrices";

function setup(boneCount = 2): { engine: EngineContext; skeleton: SkeletonData; writeTexture: ReturnType<typeof vi.fn> } {
    const writeTexture = vi.fn();
    const engine = { _device: { queue: { writeTexture } } } as unknown as EngineContext;
    const skeleton = {
        boneTexture: {} as GPUTexture,
        boneCount,
        boneMatrices: new Float32Array(boneCount * 16),
    } as SkeletonData;
    return { engine, skeleton, writeTexture };
}

describe("updateSkeletonBoneMatrices", () => {
    it("updates the CPU mirror and uploads the full bone texture", () => {
        const { engine, skeleton, writeTexture } = setup();
        const boneMatrices = Float32Array.from({ length: 32 }, (_, i) => i + 1);

        updateSkeletonBoneMatrices(engine, skeleton, boneMatrices);

        expect(skeleton.boneMatrices).toEqual(boneMatrices);
        expect(writeTexture).toHaveBeenCalledWith({ texture: skeleton.boneTexture }, skeleton.boneMatrices.buffer, { bytesPerRow: 128 }, { width: 8, height: 1 });
    });

    it("rejects a matrix payload whose bone count does not match", () => {
        const { engine, skeleton, writeTexture } = setup();

        expect(() => updateSkeletonBoneMatrices(engine, skeleton, new Float32Array(16))).toThrow("Invalid bone matrices");
        expect(writeTexture).not.toHaveBeenCalled();
    });
});
