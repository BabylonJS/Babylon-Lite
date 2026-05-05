import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "RandomNumberBlock",
    emit(block, _outputName, stage, state, ctx) {
        const seed = ctx.resolve(block, "seed", stage, state);
        if (seed.type === "f32" || seed.type === "mat4f" || seed.type === "texture2d" || seed.type === "textureCube") {
            throw new Error(`NodeMaterial: RandomNumberBlock requires a vector seed so Babylon.js getRand(seed.xy) can be emitted; got ${seed.type}`);
        }
        state[stage].helpers.set("nme_getRand", "fn nme_getRand(seed: vec2<f32>) -> f32 { return fract(sin(dot(seed.xy, vec2<f32>(12.9898, 78.233))) * 43758.5453); }");
        return { expr: `nme_getRand((${seed.expr}).xy)`, type: "f32" };
    },
};
