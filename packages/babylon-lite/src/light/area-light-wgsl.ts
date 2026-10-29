import type { BindingDecl } from "../shader/fragment-types.js";
import { wgsl } from "../shader/wgsl.js";
import type { WgslSource } from "../shader/wgsl.js";

/** @internal Always declare both LUT/sampler pairs with the helper that consumes them. */
export function areaLightBindings(): BindingDecl[] {
    return [
        { _name: "areaLtc1", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: 2 },
        { _name: "areaLtc1Sampler", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: 2 },
        { _name: "areaLtc2", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: 2 },
        { _name: "areaLtc2Sampler", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: 2 },
    ];
}

/** @internal Babylon LTC math, with deterministic handling of degenerate rectangles and normal views. */
export function areaLightWgsl(resultType = "f32", form = "areaForm", parameters = "", arguments_ = "", extraHelpers = ""): WgslSource {
    return wgsl`
struct AreaLtcResult { diffuse: ${resultType}, specular: ${resultType}, fresnel: vec2<f32> };
fn areaEdge(u: vec3<f32>, v: vec3<f32>) -> vec3<f32> {
let x = dot(u, v);
let y = abs(x);
let q = (0.8543985 + (0.4965155 + 0.0145206 * y) * y) / (3.4175940 + (4.1616724 + y) * y);
let k = select(0.5 * inverseSqrt(max(1.0 - x * x, 0.00000001)) - q, q, x > 0.0);
return cross(u, v) * k;
}
fn areaSphereForm(a: vec3<f32>, b: vec3<f32>, c: vec3<f32>, d: vec3<f32>) -> f32 {
if (dot(a,a) == 0.0 || dot(b,b) == 0.0 || dot(c,c) == 0.0 || dot(d,d) == 0.0) { return 0.0; }
let u = normalize(a);
let v = normalize(b);
let w = normalize(c);
let z = normalize(d);
let f = areaEdge(u,v) + areaEdge(v,w) + areaEdge(w,z) + areaEdge(z,u);
return max((dot(f,f) + f.z) / (length(f) + 1.0), 0.0);
}
fn areaForm(m: mat3x3<f32>, p0: vec3<f32>, p1: vec3<f32>, p2: vec3<f32>, p3: vec3<f32>) -> f32 {
return areaSphereForm(m*p0,m*p1,m*p2,m*p3);
}
${extraHelpers}
fn evaluateAreaLtc(N: vec3<f32>, V: vec3<f32>, P: vec3<f32>, entry: LightEntry, roughness: f32${parameters}) -> AreaLtcResult {
var result: AreaLtcResult;
let A = vec3<f32>(entry.vLightDiffuse.w, entry.vLightSpecular.w, entry.vLightDirection.x);
let B = entry.vLightDirection.yzw;
let normal = cross(-2.0 * A, 2.0 * B);
let p0 = entry.vLightData.xyz + A - B - P;
let p1 = entry.vLightData.xyz - A - B - P;
let p2 = entry.vLightData.xyz - A + B - P;
let p3 = entry.vLightData.xyz + A + B - P;
if (dot(normal,normal) == 0.0 || dot(normal,-p0) < 0.0) { return result; }
var tangent = V - N * dot(V,N);
if (dot(tangent,tangent) == 0.0) {
let axis = select(vec3<f32>(0.0,1.0,0.0), vec3<f32>(1.0,0.0,0.0), abs(N.y) > 0.9);
tangent = cross(axis,N);
}
let T = normalize(tangent);
let basis = transpose(mat3x3<f32>(T,-cross(N,T),N));
let uv = vec2<f32>(roughness, sqrt(1.0 - clamp(dot(N,V),0.0,1.0))) * (63.0 / 64.0) + vec2<f32>(0.5 / 64.0);
let t1 = textureSampleLevel(areaLtc1,areaLtc1Sampler,uv,0.0);
let t2 = textureSampleLevel(areaLtc2,areaLtc2Sampler,uv,0.0);
let inverseLtc = mat3x3<f32>(vec3<f32>(t1.x,0.0,t1.y),vec3<f32>(0.0,1.0,0.0),vec3<f32>(t1.z,0.0,t1.w));
result.diffuse = ${form}(basis,p0,p1,p2,p3${arguments_});
result.specular = ${form}(inverseLtc * basis,p0,p1,p2,p3${arguments_});
result.fresnel = t2.xy;
return result;
}
`;
}

/** @internal Solid emission does not import or include the textured projection/sampling helper. */
export const AREA_LIGHT_WGSL = /* @__PURE__ */ areaLightWgsl();
