/** Morph target GPU resource factory.
 *
 *  Dynamically imported by load-gltf.ts when a mesh has morph targets.
 *  Scenes without morph targets never import this module.
 *  Morph WGSL is now provided by the morph ShaderFragment
 *  (shader/fragments/morph-fragment.ts) and composed at pipeline
 *  creation time — no global registration needed. */

import type { MorphTargetData } from "../animation/types.js";
import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import { createMappedBuffer } from "../resource/gpu-buffers.js";

/** Create morph target GPU data from parsed glTF targets.
 *  @param engine       - Engine context (provides GPU device)
 *  @param targets      - Array of `{positions, normals}` deltas per target
 *  @param vertexCount  - Number of vertices in the base mesh
 *  @param morphWeights - Initial morph weights (one per target, may be null)
 */
export function createMorphTargets(
    engine: EngineContext,
    targets: { positions: Float32Array; normals: Float32Array | null }[],
    vertexCount: number,
    morphWeights: number[] | null
): MorphTargetData {
    const engineInternal = engine as EngineContextInternal;
    const device = engineInternal.device;
    const targetCount = Math.min(targets.length, 4); // max 4 (vec4 weights)
    const texWidth = Math.min(vertexCount, 2048);
    const rowsPerBand = Math.ceil(vertexCount / texWidth);
    // Each target has 2 bands: position deltas + normal deltas
    const totalRows = targetCount * 2 * rowsPerBand;

    // Build tiled rgba32float texture
    const texData = new Float32Array(texWidth * totalRows * 4);
    for (let t = 0; t < targetCount; t++) {
        const tgt = targets[t]!;
        const posBandRow = t * 2 * rowsPerBand;
        const normBandRow = (t * 2 + 1) * rowsPerBand;
        for (let v = 0; v < vertexCount; v++) {
            const col = v % texWidth;
            const row = Math.floor(v / texWidth);
            // Position deltas
            const posIdx = ((posBandRow + row) * texWidth + col) * 4;
            texData[posIdx] = tgt.positions[v * 3]!;
            texData[posIdx + 1] = tgt.positions[v * 3 + 1]!;
            texData[posIdx + 2] = tgt.positions[v * 3 + 2]!;
            // Normal deltas
            if (tgt.normals) {
                const normIdx = ((normBandRow + row) * texWidth + col) * 4;
                texData[normIdx] = tgt.normals[v * 3]!;
                texData[normIdx + 1] = tgt.normals[v * 3 + 1]!;
                texData[normIdx + 2] = tgt.normals[v * 3 + 2]!;
            }
        }
    }

    const texture = device.createTexture({
        size: [texWidth, totalRows],
        format: "rgba32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, texData.buffer, { bytesPerRow: texWidth * 16 }, { width: texWidth, height: totalRows });

    // Weights UBO: vec4 weights + count + texWidth + rowsPerBand + pad = 32 bytes
    const uboData = new ArrayBuffer(32);
    const weights = new Float32Array(uboData, 0, 4);
    const u32 = new Uint32Array(uboData, 16, 4);
    for (let i = 0; i < targetCount; i++) {
        weights[i] = morphWeights?.[i] ?? 0;
    }
    u32[0] = targetCount;
    u32[1] = texWidth;
    u32[2] = rowsPerBand;

    const weightsBuffer = createMappedBuffer(engineInternal, new Uint8Array(uboData), GPUBufferUsage.UNIFORM);

    return { texture, count: targetCount, weightsBuffer, targets: targets.slice(0, targetCount), weights };
}

/** Update morph target weights on CPU and GPU.
 *  Only the first four weights are used, matching the current morph target limit.
 *  @param engine - Engine context that owns the morph target GPU buffer.
 *  @param morphTargets - Morph target data returned by `createMorphTargets()`.
 *  @param weights - New morph weights; missing slots are reset to 0.
 */
export function setMorphTargetWeights(engine: EngineContext, morphTargets: MorphTargetData, weights: ArrayLike<number>): void {
    const count = Math.min(morphTargets.count, 4, weights.length);
    morphTargets.weights.fill(0);
    for (let i = 0; i < count; i++) {
        morphTargets.weights[i] = weights[i] ?? 0;
    }
    (engine as EngineContextInternal).device.queue.writeBuffer(morphTargets.weightsBuffer, 0, morphTargets.weights);
}
