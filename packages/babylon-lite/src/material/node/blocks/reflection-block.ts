/** ReflectionBlock — marker that activates env IBL plumbing.
 *
 *  In the current Lite NME implementation the actual reflection sampling is
 *  performed inside `PBRMetallicRoughnessBlock` (which can address the env
 *  bindings directly). ReflectionBlock therefore plays a dual role:
 *    1. Sets `state.usesEnv = true` so the pipeline allocates env bindings
 *       and the scene UBO is extended.
 *    2. Provides a placeholder vec3 output (always zero) so any consumer
 *       wiring still compiles. PBR-MR ignores the actual value — it only
 *       checks whether the input is connected.
 *
 *  Future scenes that introduce non-PBR reflection paths (e.g. custom
 *  reflection passed to ColorSplitter for visualisation) will extend this
 *  emitter to actually sample the cubemap and emit a real RGB value.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "ReflectionBlock",
    stage: "fragment",
    emit(_block, _outputName, _stage, state, _ctx) {
        state.usesEnv = true;
        return { expr: `vec3<f32>(0.0)`, type: "vec3f" };
    },
};
