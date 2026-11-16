export const OCEAN_INITIAL_SPECTRUM_WGSL = `
const PI=3.1415926;
struct Params{size:u32,lengthScale:f32,cutoffHigh:f32,cutoffLow:f32,gravity:f32,depth:f32,}
struct Spectrum{scale:f32,angle:f32,spreadBlend:f32,swell:f32,alpha:f32,peakOmega:f32,gamma:f32,shortWavesFade:f32,}
@group(0)@binding(0)var wavesData:texture_storage_2d<rgba32float,write>;
@group(0)@binding(1)var h0k:texture_storage_2d<rg32float,write>;
@group(0)@binding(2)var<uniform> params:Params;
@group(0)@binding(3)var<storage,read> spectra:array<Spectrum>;
@group(0)@binding(4)var<storage,read> gaussianNoise:array<vec2f>;
fn frequency(k:f32)->f32{return sqrt(params.gravity*k*tanh(min(k*params.depth,20.0)));}
fn frequencyDerivative(k:f32)->f32{
let th=tanh(min(k*params.depth,20.0));let ch=cosh(k*params.depth);
return params.gravity*(params.depth*k/ch/ch+th)/frequency(k)/2.0;
}
fn normalisationFactor(s:f32)->f32{
let s2=s*s;let s3=s2*s;let s4=s3*s;
if(s<5.0){return -0.000564*s4+0.00776*s3-0.044*s2+0.192*s+0.163;}
return -4.80e-08*s4+1.07e-05*s3-9.53e-04*s2+5.90e-02*s+0.393;
}
fn cosine2s(theta:f32,s:f32)->f32{return normalisationFactor(s)*pow(abs(cos(0.5*theta)),2.0*s);}
fn spreadPower(omega:f32,peak:f32)->f32{
if(omega>peak){return 9.77*pow(abs(omega/peak),-2.5);}
return 6.97*pow(abs(omega/peak),5.0);
}
fn directionSpectrum(theta:f32,omega:f32,p:Spectrum)->f32{
let s=spreadPower(omega,p.peakOmega)+16.0*tanh(min(omega/p.peakOmega,20.0))*p.swell*p.swell;
return mix(2.0/PI*cos(theta)*cos(theta),cosine2s(theta-p.angle,s),p.spreadBlend);
}
fn tma(omega:f32)->f32{
let h=omega*sqrt(params.depth/params.gravity);
if(h<=1.0){return 0.5*h*h;}if(h<2.0){return 1.0-0.5*(2.0-h)*(2.0-h);}return 1.0;
}
fn jonswap(omega:f32,p:Spectrum)->f32{
var sigma:f32;
if(omega<=p.peakOmega){sigma=0.07;}else{sigma=0.09;}
let r=exp(-(omega-p.peakOmega)*(omega-p.peakOmega)/2.0/sigma/sigma/p.peakOmega/p.peakOmega);
let io=1.0/omega;let po=p.peakOmega/omega;
return p.scale*tma(omega)*p.alpha*params.gravity*params.gravity*io*io*io*io*io*exp(-1.25*po*po*po*po)*pow(abs(p.gamma),r);
}
fn spectrum(k:f32,angle:f32,omega:f32,p:Spectrum)->f32{
return jonswap(omega,p)*directionSpectrum(angle,omega,p)*exp(-p.shortWavesFade*p.shortWavesFade*k*k);
}
@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=vec2u(params.size))){return;}
let deltaK=2.0*PI/params.lengthScale;
let k=(vec2f(id.xy)-vec2f(f32(params.size)*0.5))*deltaK;
let kl=length(k);
if(kl<params.cutoffLow||kl>params.cutoffHigh){
textureStore(h0k,vec2i(id.xy),vec4f(0.0));
textureStore(wavesData,vec2i(id.xy),vec4f(k.x,1.0,k.y,0.0));
return;
}
let omega=frequency(kl);let angle=atan2(k.y,k.x);
var density=spectrum(kl,angle,omega,spectra[0]);
if(spectra[1].scale>0.0){density+=spectrum(kl,angle,omega,spectra[1]);}
let amplitude=sqrt(2.0*density*abs(frequencyDerivative(kl))/kl*deltaK*deltaK);
textureStore(wavesData,vec2i(id.xy),vec4f(k.x,1.0/kl,k.y,omega));
textureStore(h0k,vec2i(id.xy),vec4f(gaussianNoise[id.y*params.size+id.x]*amplitude,0.0,0.0));
}`;

export const OCEAN_CONJUGATE_SPECTRUM_WGSL = `
struct Params{size:u32,lengthScale:f32,cutoffHigh:f32,cutoffLow:f32,gravity:f32,depth:f32,}
@group(0)@binding(0)var h0:texture_storage_2d<rgba32float,write>;
@group(0)@binding(1)var h0k:texture_2d<f32>;
@group(0)@binding(2)var<uniform> params:Params;
@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=vec2u(params.size))){return;}
let a=textureLoad(h0k,vec2i(id.xy),0).xy;
let mirror=vec2i(vec2u((params.size-id.x)%params.size,(params.size-id.y)%params.size));
let b=textureLoad(h0k,mirror,0).xy;
textureStore(h0,vec2i(id.xy),vec4f(a,b.x,-b.y));
}`;

export const OCEAN_TWIDDLE_WGSL = `
const PI=3.14159265359;
struct Params{size:i32,stageCount:i32,}
@group(0)@binding(0)var outputTex:texture_storage_2d<rgba32float,write>;
@group(0)@binding(1)var<uniform> params:Params;
@compute @workgroup_size(1,8,1)
fn main(@builtin(global_invocation_id) id:vec3u){
if(i32(id.x)>=params.stageCount||i32(id.y)>=params.size/2){return;}
let stage=i32(id.x);let y=i32(id.y);let b=params.size>>(id.x+1u);
let i=(2*b*(y/b)+(y%b))%params.size;
let angle=-2.0*PI*f32((y/b)*b)/f32(params.size);
let w=vec2f(cos(angle),sin(angle));
textureStore(outputTex,vec2i(stage,y),vec4f(w,f32(i),f32(i+b)));
textureStore(outputTex,vec2i(stage,y+params.size/2),vec4f(-w,f32(i),f32(i+b)));
}`;

export const OCEAN_TIME_SPECTRUM_WGSL = `
struct Params{time:f32,}
@group(0)@binding(0)var h0:texture_2d<f32>;
@group(0)@binding(1)var wavesData:texture_2d<f32>;
@group(0)@binding(2)var<uniform> params:Params;
@group(0)@binding(3)var dxDz:texture_storage_2d<rg32float,write>;
@group(0)@binding(4)var dyDxz:texture_storage_2d<rg32float,write>;
@group(0)@binding(5)var dyxDyz:texture_storage_2d<rg32float,write>;
@group(0)@binding(6)var dxxDzz:texture_storage_2d<rg32float,write>;
fn cmul(a:vec2f,b:vec2f)->vec2f{return vec2f(a.x*b.x-a.y*b.y,a.x*b.y+a.y*b.x);}
@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id) id:vec3u){
let dims=textureDimensions(h0);if(any(id.xy>=dims)){return;}
let p=vec2i(id.xy);let wave=textureLoad(wavesData,p,0);
let phase=wave.w*params.time;let e=vec2f(cos(phase),sin(phase));let h0v=textureLoad(h0,p,0);
let h=cmul(h0v.xy,e)+cmul(h0v.zw,vec2f(e.x,-e.y));let ih=vec2f(-h.y,h.x);
let dx=ih*wave.x*wave.y;let dy=h;let dz=ih*wave.z*wave.y;
let dxdx=-h*wave.x*wave.x*wave.y;let dydx=ih*wave.x;let dzdx=-h*wave.x*wave.z*wave.y;
let dydz=ih*wave.z;let dzdz=-h*wave.z*wave.z*wave.y;
textureStore(dxDz,p,vec4f(dx.x-dz.y,dx.y+dz.x,0.0,0.0));
textureStore(dyDxz,p,vec4f(dy.x-dzdx.y,dy.y+dzdx.x,0.0,0.0));
textureStore(dyxDyz,p,vec4f(dydx.x-dydz.y,dydx.y+dydz.x,0.0,0.0));
textureStore(dxxDzz,p,vec4f(dxdx.x-dzdz.y,dxdx.y+dzdz.x,0.0,0.0));
}`;

export const OCEAN_FFT_HORIZONTAL_WGSL = `
struct Params{step:i32,size:i32,}
@group(0)@binding(0)var<uniform> params:Params;
@group(0)@binding(1)var twiddle:texture_2d<f32>;
@group(0)@binding(2)var inputTex:texture_2d<f32>;
@group(0)@binding(3)var outputTex:texture_storage_2d<rg32float,write>;
fn cmul(a:vec2f,b:vec2f)->vec2f{return vec2f(a.x*b.x-a.y*b.y,a.x*b.y+a.y*b.x);}
@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=vec2u(u32(params.size)))){return;}
let data=textureLoad(twiddle,vec2i(params.step,i32(id.x)),0);
let ix=vec2i(data.zw);
let a=textureLoad(inputTex,vec2i(ix.x,i32(id.y)),0).xy;
let b=textureLoad(inputTex,vec2i(ix.y,i32(id.y)),0).xy;
textureStore(outputTex,vec2i(id.xy),vec4f(a+cmul(vec2f(data.x,-data.y),b),0.0,0.0));
}`;

export const OCEAN_FFT_VERTICAL_WGSL = `
struct Params{step:i32,size:i32,}
@group(0)@binding(0)var<uniform> params:Params;
@group(0)@binding(1)var twiddle:texture_2d<f32>;
@group(0)@binding(2)var inputTex:texture_2d<f32>;
@group(0)@binding(3)var outputTex:texture_storage_2d<rg32float,write>;
fn cmul(a:vec2f,b:vec2f)->vec2f{return vec2f(a.x*b.x-a.y*b.y,a.x*b.y+a.y*b.x);}
@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=vec2u(u32(params.size)))){return;}
let data=textureLoad(twiddle,vec2i(params.step,i32(id.y)),0);
let iy=vec2i(data.zw);
let a=textureLoad(inputTex,vec2i(i32(id.x),iy.x),0).xy;
let b=textureLoad(inputTex,vec2i(i32(id.x),iy.y),0).xy;
textureStore(outputTex,vec2i(id.xy),vec4f(a+cmul(vec2f(data.x,-data.y),b),0.0,0.0));
}`;

export const OCEAN_FFT_PERMUTE_WGSL = `
@group(0)@binding(0)var inputTex:texture_2d<f32>;
@group(0)@binding(1)var outputTex:texture_storage_2d<rg32float,write>;
@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id) id:vec3u){
let dims=textureDimensions(inputTex);if(any(id.xy>=dims)){return;}
let sign=1.0-2.0*f32((id.x+id.y)%2u);
textureStore(outputTex,vec2i(id.xy),textureLoad(inputTex,vec2i(id.xy),0)*sign);
}`;

export const OCEAN_MERGE_WGSL = `
struct Params{lambda:f32,deltaTime:f32,}
@group(0)@binding(0)var<uniform> params:Params;
@group(0)@binding(1)var displacement:texture_storage_2d<rgba16float,write>;
@group(0)@binding(2)var derivatives:texture_storage_2d<rgba16float,write>;
@group(0)@binding(3)var turbulenceRead:texture_2d<f32>;
@group(0)@binding(4)var turbulenceWrite:texture_storage_2d<rgba16float,write>;
@group(0)@binding(5)var dxDz:texture_2d<f32>;
@group(0)@binding(6)var dyDxz:texture_2d<f32>;
@group(0)@binding(7)var dyxDyz:texture_2d<f32>;
@group(0)@binding(8)var dxxDzz:texture_2d<f32>;
@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id) id:vec3u){
let dims=textureDimensions(dxDz);if(any(id.xy>=dims)){return;}let p=vec2i(id.xy);
let a=textureLoad(dxDz,p,0);let b=textureLoad(dyDxz,p,0);let c=textureLoad(dyxDyz,p,0);let d=textureLoad(dxxDzz,p,0);
textureStore(displacement,p,vec4f(params.lambda*a.x,b.x,params.lambda*a.y,0.0));
textureStore(derivatives,p,vec4f(c.x,c.y,params.lambda*d.x,params.lambda*d.y));
let jacobian=(1.0+params.lambda*d.x)*(1.0+params.lambda*d.y)-params.lambda*params.lambda*b.y*b.y;
var turbulence=textureLoad(turbulenceRead,p,0).x+params.deltaTime*0.5/max(jacobian,0.5);
turbulence=min(jacobian,turbulence);
textureStore(turbulenceWrite,p,vec4f(turbulence,turbulence,turbulence,1.0));
}`;

export const OCEAN_CLEAR_RGBA16_WGSL = `
@group(0)@binding(0)var outputTex:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id) id:vec3u){
let dims=textureDimensions(outputTex);if(any(id.xy>=dims)){return;}
textureStore(outputTex,vec2i(id.xy),vec4f(0.0));
}`;

export const OCEAN_BUOY_PROBE_WGSL = `
@group(0)@binding(0)var displacement:texture_2d<f32>;
@group(0)@binding(1)var<storage,read_write> samples:array<vec4f>;
struct ProbeParams{p0:vec4f,p1:vec4f,p2:vec4f,}
@group(0)@binding(2)var<uniform> params:ProbeParams;
fn samplePoint(world:vec2f)->vec4f{
let dims=vec2i(textureDimensions(displacement));
let p=fract(world/250.0)*vec2f(dims);
let i0=vec2i(floor(p));let f=fract(p);
let a=(i0%dims+dims)%dims;let b=(a+vec2i(1,0))%dims;let c=(a+vec2i(0,1))%dims;let d=(a+vec2i(1,1))%dims;
return mix(mix(textureLoad(displacement,a,0),textureLoad(displacement,b,0),f.x),mix(textureLoad(displacement,c,0),textureLoad(displacement,d,0),f.x),f.y);
}
@compute @workgroup_size(3,1,1)
fn main(@builtin(local_invocation_index) index:u32){
let points=array<vec2f,3>(params.p0.xz,params.p1.xz,params.p2.xz);
samples[index]=samplePoint(points[index]);
}`;
