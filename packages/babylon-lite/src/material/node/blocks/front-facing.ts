/** FrontFacingBlock — 1.0 if the fragment is front-facing, else 0.0. */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "FrontFacingBlock",
    stage: "fragment",
    emit(_block, _outputName, _stage, _state, _ctx) {
        // WGSL: `select(0.0, 1.0, frontFacing)` where `frontFacing` is a @builtin(front_facing) bool.
        // The pipeline builder wires this builtin into the fragment entry-point.
        return { expr: "select(0.0, 1.0, _NME_FRONT_FACING_)", type: "f32" };
    },
};
