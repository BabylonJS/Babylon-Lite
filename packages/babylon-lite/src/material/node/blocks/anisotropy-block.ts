/** AnisotropyBlock — anisotropic specular layer marker for PBR-MR.
 *
 *  Marker block (scene 70 — intensity-0 validation). PBR-MR walks into the
 *  connected AnisotropyBlock to read `intensity`; at intensity=0 the
 *  anisotropic GGX D and V terms reduce to standard GGX, and the bent
 *  normal reduces to the regular normal — so the marker has no rendering
 *  effect when intensity=0. Real anisotropic math will land alongside
 *  scene 72's full D8AK3Z snippet when non-zero intensities are wired.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "AnisotropyBlock",
    stage: "fragment",
    emit(_block, _outputName, _stage, state, _ctx) {
        state.usesAnisotropy = true;
        return { expr: `vec3<f32>(0.0)`, type: "vec3f" };
    },
};
