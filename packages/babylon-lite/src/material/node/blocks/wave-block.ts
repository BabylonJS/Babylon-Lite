import type { BlockEmitter, NodeValueType } from "../node-types.js";

function scalar(type: NodeValueType, value: string): string {
    if (type === "f32") {
        return value;
    }
    if (type === "vec2f") {
        return `vec2<f32>(${value})`;
    }
    if (type === "vec3f") {
        return `vec3<f32>(${value})`;
    }
    if (type === "vec4f") {
        return `vec4<f32>(${value})`;
    }
    throw new Error(`NodeMaterial: WaveBlock does not support ${type}`);
}

export const emitter: BlockEmitter = {
    className: "WaveBlock",
    emit(block, _outputName, stage, state, ctx) {
        const input = ctx.resolve(block, "input", stage, state);
        const v = input.expr;
        const half = scalar(input.type, "0.5");
        const one = scalar(input.type, "1.0");
        const two = scalar(input.type, "2.0");
        const rawKind = block.serialized.kind;
        const kind = typeof rawKind === "number" ? rawKind : 0;
        if (kind === 0) {
            return { expr: `(${v} - floor(${half} + ${v}))`, type: input.type };
        }
        if (kind === 1) {
            return { expr: `(${one} - ${two} * round(fract(${v})))`, type: input.type };
        }
        if (kind === 2) {
            return { expr: `(${two} * abs(${two} * (${v} - floor(${half} + ${v}))) - ${one})`, type: input.type };
        }
        throw new Error(`NodeMaterial: unknown WaveBlock kind ${kind}`);
    },
};
