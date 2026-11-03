import { wgsl } from "../../shader/wgsl.js";

/** @internal Independent two-stage contact-refinement solver.
 *
 * Height reads use one explicit mip chosen per pixel (footprint anisotropy capped at 2), so the
 * march never pays for gradient payloads or multi-tap anisotropic filtering. The coarse search
 * stops sampling more densely than one step per height texel at that mip, and refinement bisects
 * only until the contact bracket spans at most one pixel. */
export const _PARALLAX_WGSL = wgsl`fn parallaxTransformUV(uv:vec2f,m:vec4f,t:vec2f)->vec2f{
return vec2f(dot(m.xy,uv),dot(m.zw,uv))+t;
}
fn parallaxHeight(uv:vec2f,lod:f32,mask:vec4f)->f32{
return clamp(dot(textureSampleLevel(parallaxHeightTexture,parallaxHeightSampler,uv,lod),mask),0.0,1.0);
}
fn parallaxOffset(position:vec3f,normal:vec3f,positionDx:vec3f,positionDy:vec3f,eye:vec3f,heightUV:vec2f,heightDx:vec2f,heightDy:vec2f,heightParams:vec4f,sampling:vec4f)->vec2f{
let eyeVector=eye-position;
if(heightParams.x==0.0||dot(normal,normal)==0.0||dot(eyeVector,eyeVector)==0.0){return vec2f(0.0);}
let view=normalize(eyeVector);
var n=normalize(normal);
if(dot(n,view)<0.0){n=-n;}
let angle=clamp(dot(n,view),0.0,1.0);
let x=cross(positionDy,n);
let y=cross(n,positionDx);
let determinant=dot(positionDx,x);
let frameScale=max(dot(positionDx,positionDx),dot(positionDy,positionDy));
if(angle<=0.0001||abs(determinant)<=0.000001*frameScale){return vec2f(0.0);}
let screenRay=vec2f(dot(view,x),dot(view,y))*(heightParams.x/(determinant*angle));
let rayPixels2=dot(screenRay,screenRay);
if(rayPixels2==0.0){return vec2f(0.0);}
let heightRay=heightDx*screenRay.x+heightDy*screenRay.y;
let topUV=heightUV+heightRay*heightParams.y;
let size=vec2f(textureDimensions(parallaxHeightTexture));
let texelDx=heightDx*size;
let texelDy=heightDy*size;
let footprintX=dot(texelDx,texelDx);
let footprintY=dot(texelDy,texelDy);
let lod=clamp(0.5*log2(max(max(footprintX,footprintY)*0.25,min(footprintX,footprintY))),0.0,f32(textureNumLevels(parallaxHeightTexture)-1u));
let mask=select(vec4f(0.0),vec4f(1.0),vec4u(u32(sampling.w))==vec4u(0u,1u,2u,3u));
var aboveError=parallaxHeight(topUV,lod,mask)-1.0;
if(aboveError>=0.0){return screenRay*heightParams.y;}
if(rayPixels2<0.25){return screenRay*(heightParams.y+aboveError);}
let steps=clamp(ceil(length(heightRay*size)*exp2(-lod)),1.0,ceil(mix(sampling.x,sampling.y,1.0-angle)));
let stepCount=u32(steps);
let stepDepth=1.0/steps;
var aboveDepth=0.0;
var belowDepth=1.0;
var belowError=0.0;
for(var i=1u;i<=stepCount;i++){
let depth=f32(i)*stepDepth;
let error=depth+parallaxHeight(topUV-heightRay*depth,lod,mask)-1.0;
if(error>=0.0){belowDepth=depth;belowError=error;break;}
aboveDepth=depth;aboveError=error;
}
let bisections=u32(clamp(ceil(log2(stepDepth*sqrt(rayPixels2))),0.0,f32(32u-countLeadingZeros(u32(sampling.z)-1u))));
for(var i=0u;i<bisections;i++){
let depth=0.5*(aboveDepth+belowDepth);
let error=depth+parallaxHeight(topUV-heightRay*depth,lod,mask)-1.0;
if(error>=0.0){belowDepth=depth;belowError=error;}else{aboveDepth=depth;aboveError=error;}
}
let weight=clamp(-aboveError/(belowError-aboveError),0.0,1.0);
return screenRay*(heightParams.y-mix(aboveDepth,belowDepth,weight));
}
fn parallaxSample(surfaceTexture:texture_2d<f32>,surfaceSampler:sampler,uv:vec2f,screenOffset:vec2f)->vec4f{
let dx=dpdx(uv);
let dy=dpdy(uv);
return textureSampleGrad(surfaceTexture,surfaceSampler,uv+dx*screenOffset.x+dy*screenOffset.y,dx,dy);
}`;
