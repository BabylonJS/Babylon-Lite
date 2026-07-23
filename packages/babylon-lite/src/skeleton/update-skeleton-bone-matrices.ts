import type { SkeletonData } from "../animation/types.js";
import type { EngineContext } from "../engine/engine.js";

/** Update a skeleton's CPU bone-matrix mirror and upload it to the GPU. */
export function updateSkeletonBoneMatrices(engine: EngineContext, skeleton: SkeletonData, boneMatrices: Float32Array): void {
    if (boneMatrices.length !== skeleton.boneMatrices.length) {
        throw new Error("Invalid bone matrices");
    }
    if (boneMatrices !== skeleton.boneMatrices) {
        skeleton.boneMatrices.set(boneMatrices);
    }
    const textureWidth = skeleton.boneMatrices.length / 4;
    engine._device.queue.writeTexture({ texture: skeleton.boneTexture }, skeleton.boneMatrices, { bytesPerRow: textureWidth * 16 }, { width: textureWidth, height: 1 });
}
