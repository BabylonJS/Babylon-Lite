/** ShadowMapBlock — samples a light's shadow map and returns a shadow factor.
 *
 *  Inputs: worldPosition, worldNormal, lightDirection.
 *  Output: output (f32 in [0, 1], 1.0 = fully lit).
 *
 *  The pipeline builder is responsible for binding the shadow map +
 *  light-space-projection matrix under `_NME_SHADOW_MAP_<idx>_` sentinels.
 *  Until that integration lands this emitter returns a conservative 1.0 — the
 *  pipeline builder rewrites the expression when a real shadow generator is
 *  attached to the selected light.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "ShadowMapBlock",
    stage: "fragment",
    emit(block, _outputName, _stage, _state, _ctx) {
        const idxRaw = block.serialized.lightId;
        const idx = typeof idxRaw === "number" ? idxRaw : 0;
        return { expr: `_NME_SHADOW_${idx}_`, type: "f32" };
    },
};
