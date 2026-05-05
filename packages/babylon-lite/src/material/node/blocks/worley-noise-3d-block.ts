import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "WorleyNoise3DBlock",
    emit(block, outputName, stage, state, ctx) {
        const seed = ctx.cast(ctx.resolve(block, "seed", stage, state), "vec3f");
        const jitter = ctx.cast(ctx.resolve(block, "jitter", stage, state), "f32");
        const manhattan = block.serialized.manhattanDistance === true ? "true" : "false";
        state[stage].helpers.set(
            "nme_worley3D",
            `fn nme_worleyPermuteScalar(x: f32) -> f32 {
return ((34.0 * x + 1.0) * x) - floor(((34.0 * x + 1.0) * x) / 289.0) * 289.0;
}
fn nme_worleyDistance(x: f32, y: f32, z: f32, manhattanDistance: bool) -> f32 {
return select(x * x + y * y + z * z, abs(x) + abs(y) + abs(z), manhattanDistance);
}
fn nme_worley(P: vec3<f32>, jitter: f32, manhattanDistance: bool) -> vec2<f32> {
let K = 0.142857142857;
let Ko = 0.428571428571;
let K2 = 0.020408163265306;
let Kz = 0.166666666667;
let Kzo = 0.416666666667;
let Pi = floor(P) - floor(floor(P) / 289.0) * 289.0;
let Pf = fract(P) - vec3<f32>(0.5);
var d1 = 100000.0;
var d2 = 100000.0;
for (var zi = -1; zi <= 1; zi = zi + 1) {
for (var yi = -1; yi <= 1; yi = yi + 1) {
for (var xi = -1; xi <= 1; xi = xi + 1) {
let p0 = nme_worleyPermuteScalar(Pi.x + f32(xi));
let p1 = nme_worleyPermuteScalar(p0 + Pi.y + f32(yi));
let p2 = nme_worleyPermuteScalar(p1 + Pi.z + f32(zi));
let ox = fract(p2 * K) - Ko;
let oy = (floor(p2 * K) - floor(floor(p2 * K) / 7.0) * 7.0) * K - Ko;
let oz = floor(p2 * K2) * Kz - Kzo;
let dx = Pf.x - f32(xi) + jitter * ox;
let dy = Pf.y - f32(yi) + jitter * oy;
let dz = Pf.z - f32(zi) + jitter * oz;
let d = nme_worleyDistance(dx, dy, dz, manhattanDistance);
if (d < d1) {
d2 = d1;
d1 = d;
} else if (d < d2) {
d2 = d;
}
}
}
}
return sqrt(vec2<f32>(d1, d2));
}`
        );
        const temp = ctx.temp(state, "worley");
        state[stage].body.push(`let ${temp} = nme_worley(${seed.expr}, ${jitter.expr}, ${manhattan});`);
        return { expr: outputName === "y" ? `${temp}.y` : outputName === "output" ? temp : `${temp}.x`, type: outputName === "output" ? "vec2f" : "f32" };
    },
};
