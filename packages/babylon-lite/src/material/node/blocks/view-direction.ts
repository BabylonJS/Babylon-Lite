/** ViewDirectionBlock — normalized direction from worldPos to cameraPosition.
 *
 *  Inputs:
 *    - `worldPosition`: vec3/vec4 — we take .xyz if vec4.
 *    - `cameraPosition`: vec3.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "ViewDirectionBlock",
    emit(block, _outputName, stage, state, ctx) {
        const wp = ctx.cast(ctx.resolve(block, "worldPosition", stage, state), "vec3f").expr;
        const cp = ctx.cast(ctx.resolve(block, "cameraPosition", stage, state), "vec3f").expr;
        return { expr: `normalize(${cp} - ${wp})`, type: "vec3f" };
    },
};
