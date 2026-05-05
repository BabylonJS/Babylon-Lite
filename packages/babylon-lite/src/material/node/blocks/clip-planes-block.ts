/** ClipPlanesBlock — scene clip-plane discard.
 *
 * Supports Babylon.js' first scene/material clip plane. The block consumes a
 * world-space position, writes the signed clip distance in the vertex stage, and
 * discards fragments with a positive distance, matching BJS' WGSL include.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "ClipPlanesBlock",
    stage: "vertex",
    sideEffect: true,
    emit(block, _outputName, _stage, state, ctx) {
        state.usesClipPlanes = true;
        const memoKey = `_clip_${block.id}`;
        if (!state.vertex.memo.has(memoKey)) {
            const worldPosition = ctx.cast(ctx.resolve(block, "worldPosition", "vertex", state), "vec4f");
            if (!state.varyings.find((v) => v.name === "vClipDistance")) {
                state.varyings.push({ name: "vClipDistance", type: "f32" });
            }
            state.vertex.body.push(`out.vClipDistance = dot(${worldPosition.expr}, sceneU.clipPlane);`);
            state.vertex.memo.set(memoKey, { expr: "out.vClipDistance", type: "f32" });
        }
        if (!state.fragment.memo.has(memoKey)) {
            state.fragment.body.push(`if (in.vClipDistance > 0.0) { discard; }`);
            state.fragment.memo.set(memoKey, { expr: "in.vClipDistance", type: "f32" });
        }
        return { expr: "0.0", type: "f32" };
    },
};
