/** TransformBlock — matrix * vector.
 *
 *  BJS serializes `complementW` (default 1.0 for positions, 0.0 for directions)
 *  and `complementZ` for 2D-vector → 3D promotion. We honour both.
 */

import type { BlockEmitter } from "../node-types.js";
import { formatFloat } from "./_math-factory.js";

export const emitter: BlockEmitter = {
    className: "TransformBlock",
    emit(block, _outputName, stage, state, ctx) {
        const vector = ctx.resolve(block, "vector", stage, state);
        const transform = ctx.resolve(block, "transform", stage, state);
        const wRaw = block.serialized.complementW;
        const zRaw = block.serialized.complementZ;
        const cw = formatFloat(typeof wRaw === "number" ? wRaw : 1);
        const cz = formatFloat(typeof zRaw === "number" ? zRaw : 0);

        let vec4: string;
        switch (vector.type) {
            case "vec4f":
                vec4 = vector.expr;
                break;
            case "vec3f":
                vec4 = `vec4<f32>(${vector.expr}, ${cw})`;
                break;
            case "vec2f":
                vec4 = `vec4<f32>(${vector.expr}, ${cz}, ${cw})`;
                break;
            default:
                vec4 = `vec4<f32>(${ctx.cast(vector, "vec3f").expr}, ${cw})`;
        }
        return { expr: `(${transform.expr} * ${vec4})`, type: "vec4f" };
    },
};
