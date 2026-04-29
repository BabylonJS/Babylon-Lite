/** RefractionBlock — passthrough marker.
 *  Refraction math (refract(V,N,eta), env LOD sampling, Beer-Lambert tint)
 *  is implemented inside PBRMetallicRoughnessBlock, which walks down through
 *  SubSurfaceBlock.refraction to read this block's intensity / tintAtDistance.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "RefractionBlock",
    stage: "fragment",
    emit(_block, _outputName, _stage, _state, _ctx) {
        return { expr: `vec3<f32>(0.0)`, type: "vec3f" };
    },
};
