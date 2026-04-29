/** AnisotropyBlock — passthrough marker.
 *
 *  All anisotropic GGX math (alphaT/alphaB, anisotropic Burley D, anisotropic
 *  Smith visibility, bent-normal env reflection) is implemented inside
 *  PBRMetallicRoughnessBlock, which walks into the connected AnisotropyBlock
 *  to read its inputs (intensity, direction, uv).
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
