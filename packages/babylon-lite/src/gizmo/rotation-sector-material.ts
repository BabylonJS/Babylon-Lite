/** Rotation-sector shader — WGSL port of BJS PlaneRotationGizmo's GLSL
 *  `_RotationGizmoFragmentShader`.  Renders the "camembert" arc sector
 *  shown while the user drags the rotation gizmo.
 *
 *  Uniforms (vec3):
 *    • angles.x — starting angle (radians, in [0, 2π]) computed from the
 *      initial drag point in display-plane local space.
 *    • angles.y — accumulated drag angle delta (signed, radians).
 *    • angles.z — direction multiplier (1 when the gizmo rotates to match
 *      the attached mesh, 0 otherwise — affects sector offset).
 *    • rotationColor — RGB colour of the sector. */

import type { ShaderMaterial } from "../material/shader/shader-material.js";
import { createShaderMaterial, setShaderUniform } from "../material/shader/shader-material.js";
import { wgsl } from "../shader/wgsl.js";

const VERTEX_SOURCE = wgsl`struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);out.uv=input.uv;return out;}`;

// Port of BJS rotation sector GLSL:
//   uv = vUV - 0.5
//   angle = atan2(uv.y, uv.x) + π
//   delta = -angles.y
//   begin = angles.x - delta * angles.z
//   start = min(begin, begin + delta)
//   end   = max(begin, begin + delta)
//   ... wrap and accumulate intensity over 5 periods
//   colour = vec4(rotationColor, min(intensity * 0.25, 0.8)) * (1 - step(0.5, len))
const FRAGMENT_SOURCE = wgsl`struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{
let TWO_PI:f32=6.283185307;
let uv:vec2<f32>=input.uv-vec2<f32>(0.5,0.5);
var angle:f32=atan2(uv.y,uv.x)+3.141592;
let delta:f32=-shaderUniforms.angles.y;
let begin:f32=shaderUniforms.angles.x-delta*shaderUniforms.angles.z;
var startA:f32=select(begin+delta,begin,begin<begin+delta);
var endA:f32=select(begin+delta,begin,begin>begin+delta);
let len:f32=sqrt(dot(uv,uv));
let opacity:f32=1.0-step(0.5,len);
let base:f32=abs(floor(startA/TWO_PI))*TWO_PI;
startA=startA+base;
endA=endA+base;
var intensity:f32=0.0;
for(var i:i32=0;i<5;i=i+1){
intensity=intensity+max(step(startA,angle)-step(endA,angle),0.0);
angle=angle+TWO_PI;
}
return vec4<f32>(shaderUniforms.rotationColor,min(intensity*0.25,0.8))*opacity;
}`;

/** Build a ShaderMaterial that renders the rotation-sector "camembert" visual.
 *  The caller sets `angles` (vec3) and `rotationColor` (vec3) per frame. */
export function createRotationSectorMaterial(initialColor: [number, number, number]): ShaderMaterial {
    const material = createShaderMaterial({
        name: "rotationSector",
        vertexSource: VERTEX_SOURCE,
        fragmentSource: FRAGMENT_SOURCE,
        attributes: ["position", "uv"],
        uniforms: ["worldViewProjection", { name: "angles", type: "vec3<f32>", defaultValue: [0, 0, 1] }, { name: "rotationColor", type: "vec3<f32>", defaultValue: initialColor }],
        needAlphaBlending: true,
        backFaceCulling: false,
    });
    setShaderUniform(material, "rotationColor", initialColor);
    return material;
}
