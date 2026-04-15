/** Skeleton GPU resource factory.
 *
 *  Dynamically imported by load-gltf.ts when a mesh has skeletal data.
 *  Scenes without skeletons never import this module.
 *  Skinning WGSL is now provided by the skeleton ShaderFragment
 *  (shader/fragments/skeleton-fragment.ts) and composed at pipeline
 *  creation time — no global registration needed. */

import type { EngineContextInternal } from "../engine/engine.js";
import type { SkeletonData } from "../animation/types.js";

/** Create skeleton GPU data from parsed glTF skin.
 *  @param engine   Engine context (provides GPUDevice)
 *  @param joints   Joint indices (4 per vertex, u8 or u16)
 *  @param weights  Blend weights (4 per vertex, f32)
 *  @param boneCount Number of bones (joints) in the skeleton
 *  @param boneData  Initial bone matrices (Float32Array, 16 floats per bone)
 *  @param joints1  Extra joint indices for 8-bone skinning (JOINTS_1)
 *  @param weights1 Extra blend weights for 8-bone skinning (WEIGHTS_1)
 */
export function createSkeleton(
    engine: EngineContextInternal,
    joints: Uint16Array | Uint8Array,
    weights: Float32Array,
    boneCount: number,
    boneData: Float32Array,
    joints1?: Uint16Array | Uint8Array | null,
    weights1?: Float32Array | null
): SkeletonData {
    const device = engine.device;
    // Bone texture: rgba32float, 4 texels per bone (one mat4 column each)
    const texWidth = boneCount * 4;
    const boneTexture = device.createTexture({
        size: [texWidth, 1],
        format: "rgba32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: boneTexture }, boneData.buffer, { bytesPerRow: texWidth * 16 }, { width: texWidth, height: 1 });

    // Expand joints to Uint32Array — pipeline reads uint32x4 vertex format
    const joints32 = new Uint32Array(joints.length);
    for (let i = 0; i < joints.length; i++) {
        joints32[i] = joints[i]!;
    }

    const jointsBuffer = createVertexBuffer(engine, joints32);
    const weightsBuffer = createVertexBuffer(engine, weights);

    let joints1Buffer: GPUBuffer | null = null;
    let weights1Buffer: GPUBuffer | null = null;
    if (joints1 && weights1) {
        const joints132 = new Uint32Array(joints1.length);
        for (let i = 0; i < joints1.length; i++) {
            joints132[i] = joints1[i]!;
        }
        joints1Buffer = createVertexBuffer(engine, joints132);
        weights1Buffer = createVertexBuffer(engine, weights1);
    }

    return { boneTexture, boneCount, jointsBuffer, weightsBuffer, joints1Buffer, weights1Buffer };
}

function createVertexBuffer(engine: EngineContextInternal, data: ArrayBufferView): GPUBuffer {
    const device = engine.device;
    const buf = device.createBuffer({
        size: Math.max(data.byteLength, 4),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
    });
    new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength));
    buf.unmap();
    return buf;
}
