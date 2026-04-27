/** SubSurfaceBlock — subsurface translucency / refraction marker for PBR-MR.
 *
 *  Marker block (scene 71 — intensity-0 validation). PBR-MR ignores the
 *  block at intensity=0 (no translucency, no refraction). Real subsurface
 *  math will land alongside scene 72's full D8AK3Z snippet.
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
