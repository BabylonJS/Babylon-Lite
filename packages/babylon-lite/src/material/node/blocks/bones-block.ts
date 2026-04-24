/** BonesBlock — hardware skinning.
 *
 *  Inputs: matricesIndices, matricesWeights (+ optional extras for up to 8 bones
 *  per vertex), world (the model world matrix).
 *  Output: output (bone-skinned world matrix).
 *
 *  Scene sentinel: `nmeBones : array<mat4x4<f32>, N>` — provided by the skeleton
 *  bind group; the pipeline builder wires this when a BonesBlock is present.
 */

import type { BlockEmitter } from "../node-types.js";

const HELPER_KEY = "nme_skinning";
const HELPER_WGSL = `
fn nme_skinningMatrix(indices: vec4<f32>, weights: vec4<f32>) -> mat4x4<f32> {
    let i0 = u32(indices.x);
    let i1 = u32(indices.y);
    let i2 = u32(indices.z);
    let i3 = u32(indices.w);
    return nmeBones[i0] * weights.x
         + nmeBones[i1] * weights.y
         + nmeBones[i2] * weights.z
         + nmeBones[i3] * weights.w;
}
`;

export const emitter: BlockEmitter = {
    className: "BonesBlock",
    stage: "vertex",
    emit(block, _outputName, stage, state, ctx) {
        const world = ctx.resolve(block, "world", stage, state);
        if (!state.hasSkeleton) {
            // No skeleton on any bound mesh — pass-through the world matrix.
            return world;
        }
        state.vertex.helpers.set(HELPER_KEY, HELPER_WGSL);
        const indices = ctx.cast(ctx.resolve(block, "matricesIndices", stage, state), "vec4f").expr;
        const weights = ctx.cast(ctx.resolve(block, "matricesWeights", stage, state), "vec4f").expr;
        return { expr: `(${world.expr} * nme_skinningMatrix(${indices}, ${weights}))`, type: "mat4f" };
    },
};
