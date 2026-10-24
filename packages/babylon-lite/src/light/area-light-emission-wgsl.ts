import type { BindingDecl } from "../shader/fragment-types.js";
import { MAX_LIGHTS } from "./types.js";
import { areaLightWgsl } from "./area-light-wgsl.js";
import { wgsl } from "../shader/wgsl.js";
import type { WgslSource } from "../shader/wgsl.js";

/** @internal Constant binding count regardless of the number of textured lights. */
export function areaLightEmissionBindings(): BindingDecl[] {
    return [
        { _name: "areaEmission", _type: { _kind: "texture", _textureType: "texture_2d_array<f32>" }, _visibility: 2 },
        { _name: "areaEmissionSampler", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: 2 },
        { _name: "areaEmissionSlots", _type: { _kind: "uniform-buffer" }, _visibility: 2 },
    ];
}

const EMISSION_HELPERS = wgsl`
fn areaEmissionForm(m: mat3x3<f32>, p0: vec3<f32>, p1: vec3<f32>, p2: vec3<f32>, p3: vec3<f32>, lightIndex: u32) -> vec3<f32> {
let a = m*p0;
let b = m*p1;
let c = m*p2;
let d = m*p3;
let layer = areaEmissionSlots.slots[lightIndex / 4u][lightIndex % 4u];
if (layer == 0u) { return vec3<f32>(areaSphereForm(a,b,c,d)); }
let X = b-a;
let Y = d-a;
let n = cross(X,Y);
let squaredArea = dot(n,n);
let xx = dot(X,X);
if (squaredArea == 0.0 || xx == 0.0) { return vec3<f32>(0.0); }
let h = dot(n,a);
let projected = h*n/squaredArea-a;
let xy = dot(X,Y)/xx;
let orthoY = Y-X*xy;
let yy = dot(orthoY,orthoY);
if (yy == 0.0) { return vec3<f32>(0.0); }
let v = dot(orthoY,projected)/yy;
let u = dot(X,projected)/xx-xy*v;
let uv = vec2<f32>(0.125)+0.75*vec2<f32>(u,v);
let distance = abs(h)/pow(squaredArea,0.75);
let lod = log(max(2048.0*distance,1.0))/log(3.0);
let emission = textureSampleLevel(areaEmission,areaEmissionSampler,vec2<f32>(1.0-uv.x,uv.y),i32(layer-1u),lod).rgb;
return emission*areaSphereForm(a,b,c,d);
}
`;

/** @internal Generate at composition time to match the prepared light capacity. */
export function areaLightEmissionWgsl(): WgslSource {
    return areaLightWgsl(
        "vec3<f32>",
        "areaEmissionForm",
        ", lightIndex: u32",
        ", lightIndex",
        wgsl`
struct areaEmissionSlotsUniforms { slots: array<vec4<u32>, ${Math.ceil(MAX_LIGHTS / 4)}> };
${EMISSION_HELPERS}`
    );
}
