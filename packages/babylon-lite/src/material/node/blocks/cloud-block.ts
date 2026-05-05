import type { BlockEmitter, NodeBlock, NodeBuildState, NodeEmitContext, NodeExpr, Stage } from "../node-types.js";

function optional(block: NodeBlock, inputName: string, stage: Stage, state: NodeBuildState, ctx: NodeEmitContext): NodeExpr | null {
    const input = block.inputs.get(inputName);
    return input?.source ? ctx.resolve(block, inputName, stage, state) : null;
}

function scalarOffset(block: NodeBlock, inputName: string, stage: Stage, state: NodeBuildState, ctx: NodeEmitContext): string | null {
    const value = optional(block, inputName, stage, state, ctx);
    return value ? ctx.cast(value, "f32").expr : null;
}

export const emitter: BlockEmitter = {
    className: "CloudBlock",
    emit(block, _outputName, stage, state, ctx) {
        const seed = ctx.resolve(block, "seed", stage, state);
        if (seed.type !== "vec2f" && seed.type !== "vec3f") {
            throw new Error(`NodeMaterial: CloudBlock requires vec2 or vec3 seed; got ${seed.type}`);
        }

        state[stage].helpers.set(
            "nme_cloudNoise",
            `fn nme_cloudRandom(p: f32) -> f32 {
var temp = fract(p * 0.011);
temp *= temp + 7.5;
temp *= temp + temp;
return fract(temp);
}
fn nme_cloudNoise2(x: vec2<f32>, chaos: vec2<f32>) -> f32 {
let stepv = chaos * vec2<f32>(75.0, 120.0) + vec2<f32>(75.0, 120.0);
let i = floor(x);
let f = fract(x);
let n = dot(i, stepv);
let u = f * f * (vec2<f32>(3.0) - 2.0 * f);
return mix(mix(nme_cloudRandom(n + dot(stepv, vec2<f32>(0.0, 0.0))), nme_cloudRandom(n + dot(stepv, vec2<f32>(1.0, 0.0))), u.x), mix(nme_cloudRandom(n + dot(stepv, vec2<f32>(0.0, 1.0))), nme_cloudRandom(n + dot(stepv, vec2<f32>(1.0, 1.0))), u.x), u.y);
}
fn nme_cloudNoise3(x: vec3<f32>, chaos: vec3<f32>) -> f32 {
let stepv = chaos * vec3<f32>(60.0, 120.0, 75.0) + vec3<f32>(60.0, 120.0, 75.0);
let i = floor(x);
let f = fract(x);
let n = dot(i, stepv);
let u = f * f * (vec3<f32>(3.0) - 2.0 * f);
return mix(mix(mix(nme_cloudRandom(n + dot(stepv, vec3<f32>(0.0, 0.0, 0.0))), nme_cloudRandom(n + dot(stepv, vec3<f32>(1.0, 0.0, 0.0))), u.x), mix(nme_cloudRandom(n + dot(stepv, vec3<f32>(0.0, 1.0, 0.0))), nme_cloudRandom(n + dot(stepv, vec3<f32>(1.0, 1.0, 0.0))), u.x), u.y), mix(mix(nme_cloudRandom(n + dot(stepv, vec3<f32>(0.0, 0.0, 1.0))), nme_cloudRandom(n + dot(stepv, vec3<f32>(1.0, 0.0, 1.0))), u.x), mix(nme_cloudRandom(n + dot(stepv, vec3<f32>(0.0, 1.0, 1.0))), nme_cloudRandom(n + dot(stepv, vec3<f32>(1.0, 1.0, 1.0))), u.x), u.y), u.z);
}`
        );

        const octaves = Math.max(0, Math.trunc(typeof block.serialized.octaves === "number" ? block.serialized.octaves : 6));
        const helperKey = `nme_cloudFbm_${octaves}`;
        state[stage].helpers.set(
            helperKey,
            `fn nme_cloudFbm2_${octaves}(st: vec2<f32>, chaos: vec2<f32>) -> f32 {
var value = 0.0;
var amplitude = 0.5;
var tempST = st;
for (var i = 0; i < ${octaves}; i = i + 1) {
value += amplitude * nme_cloudNoise2(tempST, chaos);
tempST *= 2.0;
amplitude *= 0.5;
}
return value;
}
fn nme_cloudFbm3_${octaves}(x: vec3<f32>, chaos: vec3<f32>) -> f32 {
var value = 0.0;
var amplitude = 0.5;
var tempX = x;
for (var i = 0; i < ${octaves}; i = i + 1) {
value += amplitude * nme_cloudNoise3(tempX, chaos);
tempX *= 2.0;
amplitude *= 0.5;
}
return value;
}`
        );

        const st = ctx.temp(state, "cloudSeed");
        state[stage].body.push(`var ${st}: ${seed.type === "vec2f" ? "vec2<f32>" : "vec3<f32>"} = ${seed.expr};`);
        const offsetX = scalarOffset(block, "offsetX", stage, state, ctx);
        const offsetY = scalarOffset(block, "offsetY", stage, state, ctx);
        const offsetZ = scalarOffset(block, "offsetZ", stage, state, ctx);
        if (offsetX) {
            state[stage].body.push(`${st}.x += 0.1 * ${offsetX};`);
        }
        if (offsetY) {
            state[stage].body.push(`${st}.y += 0.1 * ${offsetY};`);
        }
        if (offsetZ && seed.type === "vec3f") {
            state[stage].body.push(`${st}.z += 0.1 * ${offsetZ};`);
        }

        const chaos = optional(block, "chaos", stage, state, ctx);
        const chaosExpr = chaos ? ctx.cast(chaos, seed.type).expr : seed.type === "vec2f" ? "vec2<f32>(0.0, 0.0)" : "vec3<f32>(0.0, 0.0, 0.0)";
        return { expr: seed.type === "vec2f" ? `nme_cloudFbm2_${octaves}(${st}, ${chaosExpr})` : `nme_cloudFbm3_${octaves}(${st}, ${chaosExpr})`, type: "f32" };
    },
};
