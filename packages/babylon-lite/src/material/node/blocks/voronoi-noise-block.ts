import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "VoronoiNoiseBlock",
    emit(block, outputName, stage, state, ctx) {
        const seed = ctx.cast(ctx.resolve(block, "seed", stage, state), "vec2f");
        const offset = ctx.cast(ctx.resolve(block, "offset", stage, state), "f32");
        const density = ctx.cast(ctx.resolve(block, "density", stage, state), "f32");
        state[stage].helpers.set(
            "nme_voronoi",
            `fn nme_voronoiRandom(pIn: vec2<f32>) -> vec2<f32> {
let p = vec2<f32>(dot(pIn, vec2<f32>(127.1, 311.7)), dot(pIn, vec2<f32>(269.5, 183.3)));
return fract(sin(p) * 18.5453);
}
fn nme_voronoi(seed: vec2<f32>, offset: f32, density: f32) -> vec2<f32> {
let n = floor(seed * density);
let f = fract(seed * density);
var outValue = 0.0;
var cells = 0.0;
var m = vec3<f32>(8.0);
for (var j = -1; j <= 1; j = j + 1) {
for (var i = -1; i <= 1; i = i + 1) {
let g = vec2<f32>(f32(i), f32(j));
let o = nme_voronoiRandom(n + g);
let r = g - f + (vec2<f32>(0.5) + 0.5 * sin(vec2<f32>(offset) + 6.2831 * o));
let d = dot(r, r);
if (d < m.x) {
m = vec3<f32>(d, o);
outValue = m.x;
cells = m.y;
}
}
}
return vec2<f32>(outValue, cells);
}`
        );
        const temp = ctx.temp(state, "voronoi");
        state[stage].body.push(`let ${temp} = nme_voronoi(${seed.expr}, ${offset.expr}, ${density.expr});`);
        return { expr: outputName === "cells" ? `${temp}.y` : `${temp}.x`, type: "f32" };
    },
};
