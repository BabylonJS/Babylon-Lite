/** SubSurfaceBlock — passthrough marker.
 *
 *  All actual subsurface math (translucency back-scatter, refraction sampling,
 *  Beer-Lambert tint absorption) is implemented inside PBRMetallicRoughnessBlock,
 *  which walks into the connected SubSurfaceBlock to read its inputs:
 *    - thickness, tintColor, translucencyIntensity, translucencyDiffusionDist
 *    - refraction (-> RefractionBlock for intensity / tintAtDistance)
 *  This emitter only exists to register the class and report `usesSubsurface`
 *  so the build pipeline can include any related infrastructure.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "SubSurfaceBlock",
    stage: "fragment",
    emit(_block, _outputName, _stage, state, _ctx) {
        state.usesSubsurface = true;
        return { expr: `vec3<f32>(0.0)`, type: "vec3f" };
    },
};
