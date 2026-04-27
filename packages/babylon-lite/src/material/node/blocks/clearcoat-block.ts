/** ClearCoatBlock — clear-coat layer marker for PBR-MR.
 *
 *  In the current Lite NME implementation the actual clear-coat math is
 *  performed inside `PBRMetallicRoughnessBlock` (which can address every
 *  ClearCoatBlock input directly via ctx.resolve). ClearCoatBlock therefore
 *  plays a marker role: it flips `state.usesClearcoat` so PBR-MR knows to
 *  emit the clear-coat code path, and exposes a vec3 placeholder output so
 *  any consumer wiring still type-checks. PBR-MR ignores the actual value;
 *  it only checks input connectivity and walks into this block to gather
 *  intensity / roughness / indexOfRefraction.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "ClearCoatBlock",
    stage: "fragment",
    emit(_block, _outputName, _stage, state, _ctx) {
        state.usesClearcoat = true;
        return { expr: `vec3<f32>(0.0)`, type: "vec3f" };
    },
};
