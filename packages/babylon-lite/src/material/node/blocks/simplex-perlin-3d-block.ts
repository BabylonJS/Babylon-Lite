import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "SimplexPerlin3DBlock",
    emit(block, _outputName, stage, state, ctx) {
        const seed = ctx.cast(ctx.resolve(block, "seed", stage, state), "vec3f");
        state[stage].helpers.set(
            "nme_simplexPerlin3D",
            `fn nme_simplexPerlin3D(source: vec3<f32>) -> f32 {
let SKEWFACTOR = 1.0 / 3.0;
let UNSKEWFACTOR = 1.0 / 6.0;
let SIMPLEX_CORNER_POS = 0.5;
let SIMPLEX_TETRAHEDRON_HEIGHT = 0.7071067811865476;
var P = source;
if (P.x == 0.0 && P.y == 0.0 && P.z == 0.0) {
P.x = 0.00001;
}
P *= SIMPLEX_TETRAHEDRON_HEIGHT;
var Pi = floor(P + dot(P, vec3<f32>(SKEWFACTOR)));
let x0 = P - Pi + dot(Pi, vec3<f32>(UNSKEWFACTOR));
let g = step(x0.yzx, x0.xyz);
let l = vec3<f32>(1.0) - g;
var Pi_1 = min(g.xyz, l.zxy);
var Pi_2 = max(g.xyz, l.zxy);
let x1 = x0 - Pi_1 + vec3<f32>(UNSKEWFACTOR);
let x2 = x0 - Pi_2 + vec3<f32>(SKEWFACTOR);
let x3 = x0 - vec3<f32>(SIMPLEX_CORNER_POS);
let v1234_x = vec4<f32>(x0.x, x1.x, x2.x, x3.x);
let v1234_y = vec4<f32>(x0.y, x1.y, x2.y, x3.y);
let v1234_z = vec4<f32>(x0.z, x1.z, x2.z, x3.z);
Pi = Pi - floor(Pi * (1.0 / 69.0)) * 69.0;
let Pi_inc1 = step(Pi, vec3<f32>(69.0 - 1.5)) * (Pi + vec3<f32>(1.0));
var Pt = vec4<f32>(Pi.x, Pi.y, Pi_inc1.x, Pi_inc1.y) + vec4<f32>(50.0, 161.0, 50.0, 161.0);
Pt *= Pt;
let V1xy_V2xy = mix(vec4<f32>(Pt.x, Pt.y, Pt.x, Pt.y), vec4<f32>(Pt.z, Pt.w, Pt.z, Pt.w), vec4<f32>(Pi_1.x, Pi_1.y, Pi_2.x, Pi_2.y));
Pt = vec4<f32>(Pt.x, V1xy_V2xy.x, V1xy_V2xy.z, Pt.z) * vec4<f32>(Pt.y, V1xy_V2xy.y, V1xy_V2xy.w, Pt.w);
let SOMELARGEFLOATS = vec3<f32>(635.298681, 682.357502, 668.926525);
let ZINC = vec3<f32>(48.500388, 65.294118, 63.934599);
let lowz_mods = vec3<f32>(1.0) / (SOMELARGEFLOATS + Pi.zzz * ZINC);
let highz_mods = vec3<f32>(1.0) / (SOMELARGEFLOATS + Pi_inc1.zzz * ZINC);
Pi_1 = select(highz_mods, lowz_mods, Pi_1.z < 0.5);
Pi_2 = select(highz_mods, lowz_mods, Pi_2.z < 0.5);
let hash_0 = fract(Pt * vec4<f32>(lowz_mods.x, Pi_1.x, Pi_2.x, highz_mods.x)) - vec4<f32>(0.49999);
let hash_1 = fract(Pt * vec4<f32>(lowz_mods.y, Pi_1.y, Pi_2.y, highz_mods.y)) - vec4<f32>(0.49999);
let hash_2 = fract(Pt * vec4<f32>(lowz_mods.z, Pi_1.z, Pi_2.z, highz_mods.z)) - vec4<f32>(0.49999);
let grad_results = inverseSqrt(hash_0 * hash_0 + hash_1 * hash_1 + hash_2 * hash_2) * (hash_0 * v1234_x + hash_1 * v1234_y + hash_2 * v1234_z);
let FINAL_NORMALIZATION = 37.837227241611314;
var kernel_weights = v1234_x * v1234_x + v1234_y * v1234_y + v1234_z * v1234_z;
kernel_weights = max(vec4<f32>(0.5) - kernel_weights, vec4<f32>(0.0));
kernel_weights = kernel_weights * kernel_weights * kernel_weights;
return dot(kernel_weights, grad_results) * FINAL_NORMALIZATION;
}`
        );
        return { expr: `nme_simplexPerlin3D(${seed.expr})`, type: "f32" };
    },
};
