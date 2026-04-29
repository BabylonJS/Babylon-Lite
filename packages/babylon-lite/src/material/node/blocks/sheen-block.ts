/** SheenBlock — soft cloth/velvet sheen layer marker for PBR-MR.
 *
 *  Like ClearCoatBlock, this is a marker: it flips `state.usesSheen` so PBR-MR
 *  knows to emit the Charlie-NDF + Ashikhmin-visibility code path, and PBR-MR
 *  walks into the connected SheenBlock to gather intensity / color / roughness.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "SheenBlock",
    stage: "fragment",
    emit(_block, _outputName, _stage, state, _ctx) {
        state.usesSheen = true;
        return { expr: `vec3<f32>(0.0)`, type: "vec3f" };
    },
};
