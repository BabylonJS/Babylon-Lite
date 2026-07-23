/** Morph target GPU resource factory.
 *
 *  Dynamically imported when a mesh has morph targets. Scenes without morph
 *  targets never import this module. Morph deltas live in a read-only storage
 *  buffer (not a texture) and morph weights in a second read-only storage
 *  buffer, so there is no fixed cap on the number of targets.
 *
 *  Morph WGSL is provided by the morph ShaderFragment
 *  (shader/fragments/morph-fragment-core.ts) and composed at pipeline
 *  creation time — no global registration needed. */

import { F32, U32, U8 } from "../engine/typed-arrays.js";
import { BU } from "../engine/gpu-flags.js";
import type { MorphTargetData } from "../animation/types.js";
import type { EngineContext } from "../engine/engine.js";
import { createMappedBuffer } from "../resource/gpu-buffers.js";

/** Byte size of the weights-buffer header (count u32, vertexCount u32, 2× pad) preceding the weights array. */
export const MORPH_WEIGHTS_HEADER_BYTES = 16;
/** Floats per (target, vertex) in the deltas buffer: position xyz + normal xyz. */
const MORPH_FLOATS_PER_VERTEX = 6;

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
    const targetCount = targets.length;

    // Deltas storage buffer: 6 floats per (target, vertex) — position xyz then normal xyz.
    const deltaData = new F32(targetCount * vertexCount * MORPH_FLOATS_PER_VERTEX);
    for (let t = 0; t < targetCount; t++) {
        const tgt = targets[t]!;
        const tBase = t * vertexCount * MORPH_FLOATS_PER_VERTEX;
        for (let v = 0; v < vertexCount; v++) {
            const o = tBase + v * MORPH_FLOATS_PER_VERTEX;
            deltaData[o] = tgt.positions[v * 3]!;
            deltaData[o + 1] = tgt.positions[v * 3 + 1]!;
            deltaData[o + 2] = tgt.positions[v * 3 + 2]!;
            if (tgt.normals) {
                deltaData[o + 3] = tgt.normals[v * 3]!;
                deltaData[o + 4] = tgt.normals[v * 3 + 1]!;
                deltaData[o + 5] = tgt.normals[v * 3 + 2]!;
            }
        }
    }
    const deltasBuffer = createMappedBuffer(engine, deltaData, BU.STORAGE);

    // Weights storage buffer: header (count, vertexCount, pad, pad) + one f32 weight per target.
    const headerBuf = new ArrayBuffer(MORPH_WEIGHTS_HEADER_BYTES + targetCount * 4);
    const headerU32 = new U32(headerBuf, 0, 2);
    headerU32[0] = targetCount;
    headerU32[1] = vertexCount;
    const headerWeights = new F32(headerBuf, MORPH_WEIGHTS_HEADER_BYTES, targetCount);
    for (let i = 0; i < targetCount; i++) {
        headerWeights[i] = morphWeights?.[i] ?? 0;
    }
    const weightsBuffer = createMappedBuffer(engine, new U8(headerBuf), BU.STORAGE);

    // CPU mirror of the current weights (used by deformation-aware picking and per-frame updates).
    const weights = new F32(targetCount);
    weights.set(headerWeights);

    return { deltasBuffer, count: targetCount, weightsBuffer, targets, weights };
}

/** Update morph target weights on CPU and GPU.
 *  @param engine - Engine context that owns the morph target GPU buffer.
 *  @param morphTargets - Morph target data returned by `createMorphTargets()`.
 *  @param weights - New morph weights; missing slots are reset to 0.
 */
export function setMorphTargetWeights(engine: EngineContext, morphTargets: MorphTargetData, weights: ArrayLike<number>): void {
    const count = Math.min(morphTargets.count, weights.length);
    morphTargets.weights.fill(0);
    for (let i = 0; i < count; i++) {
        morphTargets.weights[i] = weights[i] ?? 0;
    }
    // Weights live after the 16-byte header in the weights storage buffer.
    engine._device.queue.writeBuffer(morphTargets.weightsBuffer, MORPH_WEIGHTS_HEADER_BYTES, morphTargets.weights);
}
