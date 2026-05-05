import type { BlockEmitter, NodeValueType } from "../node-types.js";
import { WGSL } from "../node-types.js";

function curveScalar(type: number, v: string): string {
    switch (type) {
        case 0:
            return `(1.0 - cos((${v} * 3.1415) / 2.0))`;
        case 1:
            return `sin((${v} * 3.1415) / 2.0)`;
        case 2:
            return `(-((cos(${v} * 3.1415) - 1.0)) / 2.0)`;
        case 3:
            return `(${v} * ${v})`;
        case 4:
            return `((1.0 - ${v}) * (1.0 - ${v}))`;
        case 5:
            return `select(1.0 - pow(-2.0 * ${v} + 2.0, 2.0) / 2.0, 2.0 * ${v} * ${v}, ${v} < 0.5)`;
        case 6:
            return `(${v} * ${v} * ${v})`;
        case 7:
            return `(1.0 - pow(1.0 - ${v}, 3.0))`;
        case 8:
            return `select(1.0 - pow(-2.0 * ${v} + 2.0, 3.0) / 2.0, 4.0 * ${v} * ${v} * ${v}, ${v} < 0.5)`;
        case 9:
            return `(${v} * ${v} * ${v} * ${v})`;
        case 10:
            return `(1.0 - pow(1.0 - ${v}, 4.0))`;
        case 11:
            return `select(1.0 - pow(-2.0 * ${v} + 2.0, 4.0) / 2.0, 8.0 * ${v} * ${v} * ${v} * ${v}, ${v} < 0.5)`;
        case 12:
            return `(${v} * ${v} * ${v} * ${v} * ${v})`;
        case 13:
            return `(1.0 - pow(1.0 - ${v}, 5.0))`;
        case 14:
            return `select(1.0 - pow(-2.0 * ${v} + 2.0, 5.0) / 2.0, 16.0 * ${v} * ${v} * ${v} * ${v} * ${v}, ${v} < 0.5)`;
        case 15:
            return `select(pow(2.0, 10.0 * ${v} - 10.0), 0.0, ${v} == 0.0)`;
        case 16:
            return `select(1.0 - pow(2.0, -10.0 * ${v}), 1.0, ${v} == 1.0)`;
        case 17:
            return `select(select(select((2.0 - pow(2.0, -20.0 * ${v} + 10.0)) / 2.0, pow(2.0, 20.0 * ${v} - 10.0) / 2.0, ${v} < 0.5), 1.0, ${v} == 1.0), 0.0, ${v} == 0.0)`;
        case 18:
            return `(1.0 - sqrt(1.0 - pow(${v}, 2.0)))`;
        case 19:
            return `sqrt(1.0 - pow(${v} - 1.0, 2.0))`;
        case 20:
            return `select((sqrt(1.0 - pow(-2.0 * ${v} + 2.0, 2.0)) + 1.0) / 2.0, (1.0 - sqrt(1.0 - pow(2.0 * ${v}, 2.0))) / 2.0, ${v} < 0.5)`;
        case 21:
            return `(2.70158 * ${v} * ${v} * ${v} - 1.70158 * ${v} * ${v})`;
        case 22:
            return `(2.70158 * pow(${v} - 1.0, 3.0) + 1.70158 * pow(${v} - 1.0, 2.0))`;
        case 23:
            return `select((pow(2.0 * ${v} - 2.0, 2.0) * (3.5949095 * (${v} * 2.0 - 2.0) + 3.5949095) + 2.0) / 2.0, (pow(2.0 * ${v}, 2.0) * (3.5949095 * 2.0 * ${v} - 2.5949095)) / 2.0, ${v} < 0.5)`;
        case 24:
            return `select(select(-pow(2.0, 10.0 * ${v} - 10.0) * sin((${v} * 10.0 - 10.75) * ((2.0 * 3.1415) / 3.0)), 1.0, ${v} == 1.0), 0.0, ${v} == 0.0)`;
        case 25:
            return `select(select(pow(2.0, -10.0 * ${v}) * sin((${v} * 10.0 - 0.75) * ((2.0 * 3.1415) / 3.0)) + 1.0, 1.0, ${v} == 1.0), 0.0, ${v} == 0.0)`;
        case 26:
            return `select(select(select((pow(2.0, -20.0 * ${v} + 10.0) * sin((20.0 * ${v} - 11.125) * ((2.0 * 3.1415) / 4.5))) / 2.0 + 1.0, -(pow(2.0, 20.0 * ${v} - 10.0) * sin((20.0 * ${v} - 11.125) * ((2.0 * 3.1415) / 4.5))) / 2.0, ${v} < 0.5), 1.0, ${v} == 1.0), 0.0, ${v} == 0.0)`;
        default:
            throw new Error(`NodeMaterial: unknown CurveBlock curveType ${type}`);
    }
}

function curveExpr(type: number, input: string, inputType: NodeValueType): string {
    if (inputType === "f32") {
        return curveScalar(type, input);
    }
    if (inputType === "vec2f") {
        return `${WGSL[inputType]}(${curveScalar(type, `(${input}).x`)}, ${curveScalar(type, `(${input}).y`)})`;
    }
    if (inputType === "vec3f") {
        return `${WGSL[inputType]}(${curveScalar(type, `(${input}).x`)}, ${curveScalar(type, `(${input}).y`)}, ${curveScalar(type, `(${input}).z`)})`;
    }
    if (inputType === "vec4f") {
        return `${WGSL[inputType]}(${curveScalar(type, `(${input}).x`)}, ${curveScalar(type, `(${input}).y`)}, ${curveScalar(type, `(${input}).z`)}, ${curveScalar(type, `(${input}).w`)})`;
    }
    throw new Error(`NodeMaterial: CurveBlock does not support ${inputType}`);
}

export const emitter: BlockEmitter = {
    className: "CurveBlock",
    emit(block, _outputName, stage, state, ctx) {
        const input = ctx.resolve(block, "input", stage, state);
        const rawCurveType = block.serialized.curveType;
        const curveType = typeof rawCurveType === "number" ? rawCurveType : 2;
        return { expr: curveExpr(curveType, input.expr, input.type), type: input.type };
    },
};
