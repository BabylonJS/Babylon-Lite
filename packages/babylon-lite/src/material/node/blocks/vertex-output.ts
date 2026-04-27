/** VertexOutputBlock — terminal block for the vertex stage.
 *
 *  Writes the final clip-space position to the sentinel `_NME_VTX_OUTPUT_`,
 *  which the pipeline builder wraps with the vertex entry-point boilerplate.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "VertexOutputBlock",
    stage: "vertex",
    emit(block, _outputName, _stage, state, ctx) {
        const vector = ctx.resolve(block, "vector", "vertex", state);
        const pos = ctx.cast(vector, "vec4f").expr;
        state.vertex.body.push(`_NME_VTX_OUTPUT_ = ${pos};`);
        return { expr: pos, type: "vec4f" };
    },
};
