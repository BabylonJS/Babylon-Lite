/** PannerBlock — UV + speed * time.
 *
 * Babylon.js auto-configures `time` as an animated InputBlock, but serialized
 * graphs can also wire a constant. We simply evaluate the connected inputs; the
 * scene fixture uses a constant time value so output is deterministic.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "PannerBlock",
    emit(block, _outputName, stage, state, ctx) {
        const uv = ctx.cast(ctx.resolve(block, "uv", stage, state), "vec2f");
        const speed = ctx.cast(ctx.resolve(block, "speed", stage, state), "vec2f");
        const time = ctx.cast(ctx.resolve(block, "time", stage, state), "f32");
        return { expr: `(${uv.expr} + ${speed.expr} * ${time.expr})`, type: "vec2f" };
    },
};
