import { describe, expect, it, vi } from "vitest";

import type { SkeletonData } from "../../../packages/babylon-lite/src/animation/types";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { updateSkeletonBoneMatrices } from "../../../packages/babylon-lite/src/skeleton/update-skeleton-bone-matrices";

function setup(boneCount = 2, offset = 0): { engine: EngineContext; skeleton: SkeletonData; writeTexture: ReturnType<typeof vi.fn> } {
    const writeTexture = vi.fn();
    const engine = { _device: { queue: { writeTexture } } } as unknown as EngineContext;
    const storage = new Float32Array(boneCount * 16 + offset);
    const skeleton = {
        boneTexture: {} as GPUTexture,
        boneCount,
        boneMatrices: storage.subarray(offset),
    } as SkeletonData;
    return { engine, skeleton, writeTexture };
}

describe("updateSkeletonBoneMatrices", () => {
    it("updates the CPU mirror and uploads the full bone texture", () => {
        const { engine, skeleton, writeTexture } = setup(2, 4);
        const boneMatrices = Float32Array.from({ length: 32 }, (_, i) => i + 1);

        updateSkeletonBoneMatrices(engine, skeleton, boneMatrices);

        expect(skeleton.boneMatrices).toEqual(boneMatrices);
        expect(skeleton.boneMatrices.byteOffset).toBe(16);
        expect(writeTexture).toHaveBeenCalledWith({ texture: skeleton.boneTexture }, skeleton.boneMatrices, { bytesPerRow: 128 }, { width: 8, height: 1 });
    });

    it("rejects a matrix payload whose bone count does not match", () => {
        const { engine, skeleton, writeTexture } = setup();

        expect(() => updateSkeletonBoneMatrices(engine, skeleton, new Float32Array(16))).toThrow("Invalid bone matrices");
        expect(writeTexture).not.toHaveBeenCalled();
    });
});
