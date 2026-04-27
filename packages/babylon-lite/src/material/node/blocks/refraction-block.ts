/** RefractionBlock — refraction layer marker for SubSurface.
 *  Marker only — full refraction math is future work.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "RefractionBlock",
    stage: "fragment",
    emit(_block, _outputName, _stage, _state, _ctx) {
        return { expr: `vec3<f32>(0.0)`, type: "vec3f" };
    },
};
