export const COMPARISON_VERTEX = `struct EffectVertexOutput{@builtin(position) position:vec4f,@location(0) uv:vec2f}
@vertex fn effectFullscreenVertex(@builtin(vertex_index) i:u32)->EffectVertexOutput{
let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];
return EffectVertexOutput(vec4f(p,0,1),vec2f(p.x*0.5+0.5,0.5-p.y*0.5));}`;

export const COMPARISON_FRAGMENT = `@group(0) @binding(0) var sceneColor:texture_2d<f32>;
@group(0) @binding(1) var currentAO:texture_2d<f32>;
@group(0) @binding(2) var existingAO:texture_2d<f32>;
@group(0) @binding(3) var linearSampler:sampler;
struct Options{algorithm:f32,split:f32,aoOnly:f32,divider:f32,intensity:f32,ssaoDisabled:f32,p1:f32,p2:f32}
@group(0) @binding(4) var<uniform> options:Options;
@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4f{
var current=options.algorithm<0.5;
if(options.split>0.5){current=input.uv.x<options.divider;}
var visibility=1.0;
if(options.ssaoDisabled<0.5){
if(current){visibility=textureSampleLevel(currentAO,linearSampler,input.uv,0).r;}
else{visibility=1.0-textureSampleLevel(existingAO,linearSampler,input.uv,0).r*3.0;}
}
visibility=1.0-clamp((1.0-visibility)*options.intensity,0.0,1.0);
var result=vec4f(vec3f(visibility),1);
if(options.aoOnly<0.5){let color=textureSampleLevel(sceneColor,linearSampler,input.uv,0);result=vec4f(color.rgb*visibility,color.a);}
if(options.ssaoDisabled<0.5&&options.split>0.5&&abs(input.uv.x-options.divider)<0.75/f32(textureDimensions(sceneColor).x)){result=vec4f(0.25,0.7,1,1);}
return result;
}`;
