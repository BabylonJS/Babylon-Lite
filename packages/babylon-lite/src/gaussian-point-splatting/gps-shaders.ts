import { wgsl, type WgslSource } from "../shader/wgsl.js";

export const GPS_UNIFORMS = wgsl`
struct Params {
world: mat4x4f, view: mat4x4f, projection: mat4x4f,
eye: vec4f, resolution: vec4f, output: vec4f, data: vec4f,
state: vec4f, range: vec4f, cycle: vec4f,
}
`;

const MATH = wgsl`
fn hash(v: u32) -> u32 {
var x = v * 747796405u + 2891336453u;
x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
return (x >> 22u) ^ x;
}
fn random(seed: ptr<function,u32>) -> f32 {
*seed = hash(*seed);
return min(f32(*seed) * 2.3283064365386963e-10, 0.99999994);
}
fn dilogSeries(x: f32) -> f32 {
var power = x;
var sum = 0.0;
for (var k = 1u; k <= 16u; k++) {
sum += power / f32(k*k);
power *= x;
}
return sum;
}
fn dilog(x: f32) -> f32 {
if (x <= 0.5) { return dilogSeries(x); }
return 1.64493406685 - log(max(x,1e-30))*log(max(1.0-x,1e-30)) - dilogSeries(1.0-x);
}
fn inverseDilog(y: f32) -> f32 {
var x = clamp(y / 1.64493406685, 1e-7, 0.9999999);
for (var i = 0u; i < 5u; i++) {
let derivative = -log(max(1.0-x,1e-7))/x;
x = clamp(x - (dilog(x)-y)/derivative, 1e-7, 0.9999999);
}
return x;
}
fn poisson(mean: f32, seed: ptr<function,u32>) -> u32 {
let u = random(seed);
if (mean < 12.0) {
var term = exp(-mean);
var sum = term;
var k = 0u;
loop {
if (u < sum || (f32(k)>mean && term<1e-7)) { break; }
k++;
term *= mean/f32(k);
sum += term;
}
return k;
}
let z = sqrt(-2.0*log(max(u,1e-7)))*cos(6.28318530718*random(seed));
let z2=z*z;
let correction=(z2*(z2/270.0+7.0/810.0)-8.0/405.0)/mean;
return u32(max(0.0,round(mean+sqrt(mean)*z+(z2-1.0)/6.0-z*(z2+2.0)/(72.0*sqrt(mean))+correction)));
}
fn intensity(a: f32) -> f32 { return -log(1.0-min(a,0.999)); }
`;

const SCREEN = wgsl`
struct Screen { meanConic: vec4f, conicChol: vec4f, color: vec4f, depthRect: vec4u }
`;

function shCode(degree: number): { bindings: WgslSource; body: WgslSource } {
    if (!degree) {
        return { bindings: wgsl``, body: wgsl`` };
    }
    const terms = [
        "-0.48860251*y",
        "0.48860251*z",
        "-0.48860251*x",
        "1.092548430*x*y",
        "-1.09254843*y*z",
        "0.315391565*(2.0*zz-xx-yy)",
        "-1.09254843*x*z",
        "0.546274215*(xx-yy)",
        "-0.59004358*y*(3.0*xx-yy)",
        "2.890611442*x*y*z",
        "-0.45704579*y*(4.0*zz-xx-yy)",
        "0.373176332*z*(2.0*zz-3.0*xx-3.0*yy)",
        "-0.45704579*x*(4.0*zz-xx-yy)",
        "1.445305721*z*(xx-yy)",
        "-0.59004358*x*(xx-3.0*yy)",
        "2.5033429418*x*y*(xx-yy)",
        "-1.7701307698*y*z*(3.0*xx-yy)",
        "0.9461746958*x*y*(7.0*zz-1.0)",
        "-0.6690465436*y*z*(7.0*zz-3.0)",
        "0.1057855469*(zz*(35.0*zz-30.0)+3.0)",
        "-0.6690465436*x*z*(7.0*zz-3.0)",
        "0.4730873479*(xx-yy)*(7.0*zz-1.0)",
        "-1.7701307698*x*z*(xx-3.0*yy)",
        "0.6258357354*(xx*(xx-3.0*yy)-yy*(3.0*xx-yy))",
    ];
    const count = (degree + 1) ** 2 - 1;
    let bindings = wgsl``;
    let body = wgsl`
let w0 = u.world[0].xyz;
let w1 = u.world[1].xyz;
let w2 = u.world[2].xyz;
let inverseWorld = transpose(mat3x3f(cross(w1,w2),cross(w2,w0),cross(w0,w1))) * (1.0 / dot(w0,cross(w1,w2)));
let direction = normalize(inverseWorld*(wp.xyz-u.eye.xyz));
let x = direction.x; let y = -direction.y; let z = direction.z;
let xx = x*x; let yy = y*y; let zz = z*z;
`;
    for (let i = 0; i < Math.ceil((count * 3) / 16); i++) {
        bindings = wgsl`${bindings}
@group(0) @binding(${8 + i}) var sh${i}: texture_2d<u32>;`;
        body = wgsl`${body}
let shWords${i} = textureLoad(sh${i},uv,0);`;
    }
    for (let i = 0; i < count; i++) {
        const components = [0, 1, 2].map((channel) => {
            const b = i * 3 + channel;
            return `f32((shWords${Math.floor(b / 16)}[${Math.floor((b % 16) / 4)}] >> ${8 * (b % 4)}u) & 255u)* (2.0/255.0)-1.0`;
        });
        body = wgsl`${body}
color += (${terms[i]!})*vec3f(${components.join(",")});`;
    }
    return { bindings, body };
}

/** @internal Generates independent static-texture and canonical-stream input variants. */
export function gpsPreprocessShader(stream: boolean, degree: number): WgslSource {
    const sh = shCode(stream ? 0 : degree);
    const input = stream
        ? wgsl`
struct Canonical { centerOpacity: vec4f, covarianceA: vec4f, covarianceB: vec4f, color: vec4f }
@group(0) @binding(4) var<storage,read> source: array<Canonical>;
@group(0) @binding(5) var<storage,read_write> total: array<atomic<u32>>;
`
        : wgsl`
@group(0) @binding(4) var centers: texture_2d<f32>;
@group(0) @binding(5) var covarianceA: texture_2d<f32>;
@group(0) @binding(6) var covarianceB: texture_2d<f32>;
@group(0) @binding(7) var colors: texture_2d<f32>;
${sh.bindings}
`;
    const read = stream
        ? wgsl`
let record = source[g];
let center = record.centerOpacity.xyz;
let ca = record.covarianceA.xyz;
let cb = vec3f(record.covarianceA.w,record.covarianceB.xy);
var color = record.color.rgb;
let opacity = clamp(record.centerOpacity.w,0.0,1.0);
`
        : wgsl`
let uv = vec2i(i32(g%u32(u.output.w)),i32(g/u32(u.output.w)));
let center = textureLoad(centers,uv,0).xyz;
let ca = textureLoad(covarianceA,uv,0).xyz;
let cb = textureLoad(covarianceB,uv,0).xyz;
let rgba = textureLoad(colors,uv,0);
var color = rgba.rgb;
let opacity = clamp(rgba.a,0.0,1.0);
`;
    return wgsl`
${GPS_UNIFORMS}${SCREEN}${MATH}
@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var<storage,read_write> weights: array<u32>;
@group(0) @binding(2) var<storage,read_write> screen: array<Screen>;
@group(0) @binding(3) var<storage,read> hiz: array<f32>;
${input}
fn occluded(mean: vec2f, radius: f32, depth: f32) -> bool {
let level = u32(clamp(ceil(log2(max(1.0,radius))),0.0,u.range.z-1.0));
var w = u32(u.resolution.x); var h = u32(u.resolution.y); var offset = 0u;
for (var l=0u; l<level; l++) { offset+=w*h; w=max(1u,w/2u); h=max(1u,h/2u); }
let lo = min(vec2u(max(floor(mean-radius),vec2f(0.0)))/ (1u<<level),vec2u(w-1u,h-1u));
let hi = min(vec2u(max(ceil(mean+radius),vec2f(0.0)))/ (1u<<level),vec2u(w-1u,h-1u));
var farthest = 0.0;
for (var y=lo.y; y<=hi.y; y++) {
for (var x=lo.x; x<=hi.x; x++) { farthest=max(farthest,hiz[offset+y*w+x]); }
}
return farthest<depth;
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
let g=id.x+id.y*65535u*256u;
if (g>=u32(u.data.x)) { return; }
weights[g]=0u;
let linear=u.cycle.w>0.5 && u.range.w>0.5 && u.range.w<1.5;
if(linear) { screen[g].color=vec4f(0.0); }
${read}
let wp=u.world*vec4f(center,1.0);
let mv=u.view*u.world;
let vp=u.view*wp;
let clip=u.projection*vp;
if (clip.w<=0.0 || vp.z<=u.resolution.z || (u.resolution.w>0.0 && vp.z>=u.resolution.w)) { return; }
let ndc=clip.xyz/clip.w;
if (any(abs(ndc.xy)>vec2f(1.3)) || ndc.z<0.0 || ndc.z>1.0 || opacity<=0.0) { return; }
let n=u.output.z;
let size=u.output.xy/n;
let mean=vec2f(ndc.x*0.5+0.5,0.5-ndc.y*0.5)*size+(vec2f(n*0.5)-u.cycle.xy-0.5)/n;
let rowW=vec3f(u.projection[0].w,u.projection[1].w,u.projection[2].w);
let rowX=vec3f(u.projection[0].x,u.projection[1].x,u.projection[2].x);
let rowY=vec3f(u.projection[0].y,u.projection[1].y,u.projection[2].y);
let jx=(rowX-ndc.x*rowW)*(0.5*size.x/clip.w);
let jy=(rowY-ndc.y*rowW)*(-0.5*size.y/clip.w);
let rotation=transpose(mat3x3f(mv[0].xyz,mv[1].xyz,mv[2].xyz));
let ax=rotation*jx; let ay=rotation*jy;
let covariance=mat3x3f(ca,vec3f(ca.y,cb.xy),vec3f(ca.z,cb.yz));
// Lite's stored covariance uses doubled scale; the classic quad cancels it through its viewport mapping.
var a=dot(ax,covariance*ax)*0.25+0.075/(n*n);
var b=dot(ax,covariance*ay)*0.25;
var c=dot(ay,covariance*ay)*0.25+0.075/(n*n);
if(linear) {
a+=0.000025; c+=0.000025;
let mid=(a+c)*0.5; let radius=length(vec2f((a-c)*0.5,b));
let major=min(mid+radius,131072.0); let minor=min(mid-radius,131072.0);
let scale=select(0.0,(major-minor)/max(2.0*radius,1e-30),radius>0.0);
a=(major+minor)*0.5+(a-mid)*scale;
c=(major+minor)*0.5+(c-mid)*scale; b*=scale;
}
let determinant=a*c-b*b;
if (!(determinant>0.0)) { return; }
let radius=sqrt(8.0*((a+c)*0.5+length(vec2f((a-c)*0.5,b))));
if (u.state.w>0.5 && occluded(mean,radius,vp.z)) { return; }
if(!linear) { ${sh.body} }
let lo=clamp(floor(mean-sqrt(8.0*vec2f(a,c))),vec2f(0.0),u.resolution.xy);
let hi=clamp(ceil(mean+sqrt(8.0*vec2f(a,c))),vec2f(0.0),u.resolution.xy);
let ellipse=6.28318530718*sqrt(determinant)*dilog(opacity);
let rect=intensity(opacity)*(hi.x-lo.x)*(hi.y-lo.y);
var seed=hash(g^hash(u32(u.data.z)));
var weight=1u;
if(!linear) { weight=poisson(min(ellipse,rect)*u.data.y,&seed); }
if (weight==0u) { return; }
${
    stream
        ? wgsl`
let radiance=bitcast<u32>(max(0.0,max(color.r,max(color.g,color.b))));
if(radiance>atomicLoad(&total[1])) { atomicMax(&total[1],radiance); }
`
        : wgsl``
}
let chol=sqrt(a);
let depth=u32(clamp((vp.z-u.range.x)/max(1e-6,u.range.y-u.range.x),0.0,1.0)*65534.0);
screen[g]=Screen(vec4f(mean,c/determinant,-b/determinant),
vec4f(a/determinant,chol,b/chol,sqrt(max(0.0,c-b*b/a))),vec4f(select(color,vec3f(vp.z,0.0,0.0),linear),opacity),
vec4u(depth,select(0u,1u,rect<ellipse),u32(lo.x)|(u32(lo.y)<<16u),u32(hi.x)|(u32(hi.y)<<16u)));
weights[g]=min(weight,0xffffff00u);
}
`;
}

const SCAN_SHARED = wgsl`
${GPS_UNIFORMS}
@group(0) @binding(0) var<uniform> u: Params;
fn add(a:u32,b:u32)->u32 { return a+min(b,0xffffff00u-a); }
var<workgroup> values: array<u32,256>;
fn scan(t:u32,value:u32)->u32 {
values[t]=value;
workgroupBarrier();
for(var stride=1u;stride<256u;stride*=2u) {
var previous=0u;
if(t>=stride) { previous=values[t-stride]; }
workgroupBarrier();
values[t]=add(values[t],previous);
workgroupBarrier();
}
if(t==0u) { return 0u; }
return values[t-1u];
}
`;

export const GPS_SCAN_BLOCKS = wgsl`
${SCAN_SHARED}
@group(0) @binding(1) var<storage,read> weights:array<u32>;
@group(0) @binding(2) var<storage,read_write> cdf:array<u32>;
@group(0) @binding(3) var<storage,read_write> sums:array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) t:u32,@builtin(workgroup_id) group:vec3u) {
let block=group.x+group.y*65535u;
let i=block*256u+t;
var value=0u;
if(i<u32(u.data.x)) { value=weights[i]; }
let prefix=scan(t,value);
if(i<u32(u.data.x)) { cdf[i]=prefix; }
if(t==255u) { sums[block]=add(prefix,value); }
}
`;
export const GPS_SCAN_SUMS = wgsl`
${SCAN_SHARED}
@group(0) @binding(1) var<storage,read_write> sums:array<u32>;
@group(0) @binding(2) var<storage,read_write> total:array<u32>;
@group(0) @binding(3) var<storage,read_write> indirect:array<u32>;
var<workgroup> carry:u32;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) t:u32) {
let blocks=(u32(u.data.x)+255u)/256u;
if(t==0u) { carry=0u; }
workgroupBarrier();
for(var base=0u;base<blocks;base+=256u) {
let i=base+t;
var value=0u;
if(i<blocks) { value=sums[i]; }
let prefix=scan(t,value);
if(i<blocks) { sums[i]=add(carry,prefix); }
workgroupBarrier();
if(t==255u) { carry=add(carry,add(prefix,value)); }
workgroupBarrier();
}
if(t==0u) {
let groups=carry/256u+select(0u,1u,carry%256u!=0u);
total[0]=carry;
indirect[0]=min(groups,65535u);
indirect[1]=groups/65535u+select(0u,1u,groups%65535u!=0u);
indirect[2]=1u;
}
}
`;
export const GPS_SCAN_ADD = wgsl`
${GPS_UNIFORMS}
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read_write> cdf:array<u32>;
@group(0) @binding(2) var<storage,read> sums:array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id:vec3u) {
let i=id.x+id.y*65535u*256u;
if(i<u32(u.data.x)) { cdf[i]=min(cdf[i],0xffffff00u-sums[i/256u])+sums[i/256u]; }
}
`;

const FIND = wgsl`
fn find(point:u32,lower:u32,upper:u32)->u32 {
var lo=lower; var hi=upper;
loop {
if(lo+1u>=hi) { break; }
let mid=lo+(hi-lo)/2u;
if(cdf[mid]<=point) { lo=mid; } else { hi=mid; }
}
return lo;
}
`;
export const GPS_PARTITION = wgsl`
${GPS_UNIFORMS}
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read> cdf:array<u32>;
@group(0) @binding(2) var<storage,read> total:array<u32>;
@group(0) @binding(3) var<storage,read_write> buckets:array<u32>;
${FIND}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id:vec3u) {
let k=id.x;
if(k>65536u) { return; }
if(total[0]==0u || u.data.x==0.0) { buckets[k]=0u; return; }
let p=min(u32(f32(k)/65536.0*f32(total[0])),total[0]-1u);
buckets[k]=find(p,0u,u32(u.data.x));
}
`;

export const GPS_SPLAT = wgsl`
${GPS_UNIFORMS}${SCREEN}${MATH}
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read> cdf:array<u32>;
@group(0) @binding(2) var<storage,read> total:array<u32>;
@group(0) @binding(3) var<storage,read> buckets:array<u32>;
@group(0) @binding(4) var<storage,read> screen:array<Screen>;
@group(0) @binding(5) var<storage,read_write> image:array<atomic<u32>>;
${FIND}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id:vec3u) {
let row=id.y*65535u*256u;
if(row>=total[0] || id.x>=total[0]-row) { return; }
let p=row+id.x;
let bucket=min(u32(f32(p)/f32(total[0])*65536.0),65535u);
let g=find(p,buckets[select(0u,bucket-1u,bucket>0u)],min(u32(u.data.x),buckets[min(bucket+2u,65536u)]+1u));
let s=screen[g];
var seed=hash(p^hash(u32(u.data.z)));
let a=random(&seed); let b=random(&seed);
var offset:vec2f;
if(s.depthRect.y==1u) {
let lo=vec2f(f32(s.depthRect.z&65535u),f32(s.depthRect.z>>16u));
let hi=vec2f(f32(s.depthRect.w&65535u),f32(s.depthRect.w>>16u));
offset=mix(lo,hi,vec2f(a,b))-s.meanConic.xy;
} else {
let r=sqrt(max(0.0,-2.0*log(clamp(inverseDilog((1.0-a)*dilog(s.color.a))/max(s.color.a,1e-30),1e-30,1.0))));
let normal=r*vec2f(cos(6.28318530718*b),sin(6.28318530718*b));
offset=vec2f(s.conicChol.y*normal.x,s.conicChol.z*normal.x+s.conicChol.w*normal.y);
}
let distance=s.meanConic.z*offset.x*offset.x+2.0*s.meanConic.w*offset.x*offset.y+s.conicChol.x*offset.y*offset.y;
let alpha=s.color.a*exp(-0.5*distance);
if(distance>8.0 || alpha<1.0/255.0) { return; }
if(s.depthRect.y==1u && random(&seed)*intensity(s.color.a)>=intensity(alpha)) { return; }
let pixel=vec2i(floor(s.meanConic.xy+offset));
if(any(pixel<vec2i(0)) || any(pixel>=vec2i(u.resolution.xy))) { return; }
let dither=vec3f(random(&seed),random(&seed),random(&seed))-0.5;
let scale=max(u.eye.w,bitcast<f32>(total[1]));
let color=clamp(s.color.rgb/scale+dither/vec3f(31.0,63.0,31.0),vec3f(0.0),vec3f(1.0));
let q=vec3u(color*vec3f(31.0,63.0,31.0)+0.5);
let packed=(q.x<<11u)|(q.y<<5u)|q.z;
let key=(s.depthRect.x<<16u)|(packed^u32(u.data.w));
let index=u32(pixel.y)*u32(u.resolution.x)+u32(pixel.x);
if(atomicLoad(&image[index])>key) { atomicMin(&image[index],key); }
}
`;

const LINEAR_DEPTH = wgsl`
fn viewDepth(z:f32)->f32 {
return (u.projection[3].z-z*u.projection[3].w)/(z*u.projection[2].w-u.projection[2].z);
}
fn linearDepth(z:f32)->f32 {
return clamp((viewDepth(z)-viewDepth(1.0))/(viewDepth(0.0)-viewDepth(1.0)),0.0,1.0);
}
`;

export function gpsResolveShader(sceneDepth = false, compare: GPUCompareFunction = "greater-equal", linear = false): WgslSource {
    const comparisons: Record<GPUCompareFunction, WgslSource> = {
        never: wgsl`false`,
        less: wgsl`z<opaque`,
        equal: wgsl`z==opaque`,
        "less-equal": wgsl`z<=opaque`,
        greater: wgsl`z>opaque`,
        "not-equal": wgsl`z!=opaque`,
        "greater-equal": wgsl`z>=opaque`,
        always: wgsl`true`,
    };
    return wgsl`
${GPS_UNIFORMS}
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read_write> image:array<atomic<u32>>;
@group(0) @binding(2) var<storage,read_write> accum:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> depth:array<f32>;
@group(0) @binding(4) var<storage,read_write> counts:array<u32>;
@group(0) @binding(5) var<storage,read_write> hiz:array<f32>;
@group(0) @binding(6) var<storage,read> total:array<u32>;
${
    sceneDepth
        ? wgsl`
@group(0) @binding(7) var<storage,read_write> previousSceneDepth:array<f32>;
@group(0) @binding(8) var sceneDepth:texture_depth_2d;
`
        : wgsl``
}
${linear ? wgsl`@group(0) @binding(${sceneDepth ? 9 : 7}) var linearDepthTexture:texture_depth_2d;` : wgsl``}
${LINEAR_DEPTH}
fn visible(color:vec4f,z:f32,p:vec2u)->vec4f {
${sceneDepth ? wgsl`let opaque=textureLoad(sceneDepth,vec2i(p),0); if(!(${comparisons[compare]})) { return vec4f(0.0); }` : wgsl``}
return color;
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u) {
if(any(id.xy>=vec2u(u.resolution.xy))) { return; }
let i=id.y*u32(u.resolution.x)+id.x;
let key=atomicExchange(&image[i],0xffffffffu);
${linear ? wgsl`let discDepth=textureLoad(linearDepthTexture,vec2i(id.xy),0);` : wgsl``}
let hit=${linear ? wgsl`discDepth>0.0` : wgsl`key!=0xffffffffu`};
let rgb=(key^u32(u.data.w))&65535u;
let scale=max(u.eye.w,bitcast<f32>(total[1]));
let color=vec3f(f32((rgb>>11u)&31u)/31.0,f32((rgb>>5u)&63u)/63.0,f32(rgb&31u)/31.0)*scale;
let vz=mix(u.range.x,u.range.y,f32(key>>16u)/65534.0);
let projected=(u.projection[2].z*vz+u.projection[3].z)/(u.projection[2].w*vz+u.projection[3].w);
let sampleDepth=${linear ? wgsl`discDepth` : wgsl`select(0.0,clamp(projected,0.0,1.0),hit)`};
let shaded=select(color,vec3f(linearDepth(sampleDepth)),u.cycle.w>0.5 && u.range.w>0.5);
let sampleColor=select(vec4f(0.0),vec4f(shaded,1.0),hit);
hiz[i]=1e30;
let n=u32(u.output.z);
let gen=u32(u.state.x);
${
    sceneDepth
        ? wgsl`
for(var y=0u;y<n;y++) { for(var x=0u;x<n;x++) {
let p=id.xy*n+vec2u(x,y);
if(all(p<vec2u(u.output.xy))) {
let o=p.y*u32(u.output.x)+p.x;
let opaque=textureLoad(sceneDepth,vec2i(p),0);
if(previousSceneDepth[o]!=opaque) { counts[o]=gen<<16u; accum[o]=vec4f(0.0); depth[o]=0.0; }
previousSceneDepth[o]=opaque;
}
} }
`
        : wgsl``
}
${
    linear
        ? wgsl`
let value=visible(sampleColor,sampleDepth,id.xy);
accum[i]=value; depth[i]=select(0.0,sampleDepth,value.a>0.0); counts[i]=(gen<<16u)|1u;
`
        : wgsl`
if(u.state.z>0.5 && u.state.z<1.5) {
for(var y=0u;y<n;y++) { for(var x=0u;x<n;x++) {
let pixel=id.xy*n+vec2u(x,y);
if(all(pixel<vec2u(u.output.xy))) {
let o=pixel.y*u32(u.output.x)+pixel.x;
let value=visible(sampleColor,sampleDepth,pixel);
accum[o]=value; depth[o]=select(0.0,sampleDepth,value.a>0.0); counts[o]=(gen<<16u)|1u;
${sceneDepth ? wgsl`previousSceneDepth[o]=textureLoad(sceneDepth,vec2i(pixel),0);` : wgsl``}
}
} }
return;
}
let pixel=id.xy*n+vec2u(u.cycle.xy);
if(u.state.z>1.5 && u.state.z<2.5) {
for(var y=0u;y<n;y++) { for(var x=0u;x<n;x++) {
let p=id.xy*n+vec2u(x,y);
if(all(p<vec2u(u.output.xy)) && any(p!=pixel)) {
let o=p.y*u32(u.output.x)+p.x;
if(counts[o]==(gen<<16u)) {
let value=visible(sampleColor,sampleDepth,p);
accum[o]=value; depth[o]=select(0.0,sampleDepth,value.a>0.0);
}
}
} }
}
if(any(pixel>=vec2u(u.output.xy))) { return; }
let o=pixel.y*u32(u.output.x)+pixel.x;
let previous=counts[o];
var count=min(select(0u,previous&65535u,(previous>>16u)==gen),u32(u.state.y));
${
    sceneDepth
        ? wgsl`
if(u.state.z>2.5 && (previous>>16u)==gen && (previous&65535u)>u32(u.state.y)) { return; }
`
        : wgsl``
}
let value=visible(sampleColor,sampleDepth,pixel);
let weight=1.0/f32(count+1u);
accum[o]=mix(accum[o],value,weight);
counts[o]=(gen<<16u)|min(count+1u,65535u);
if(value.a>0.0 || count==0u) { depth[o]=select(0.0,sampleDepth,value.a>0.0); }
`
}
}
`;
}

export const GPS_RESOLVE = /* @__PURE__ */ gpsResolveShader();

export const GPS_SCENE_HIZ = wgsl`
${GPS_UNIFORMS}
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read_write> hiz:array<f32>;
@group(0) @binding(2) var source:texture_depth_2d;
${LINEAR_DEPTH}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u) {
if(any(id.xy>=vec2u(u.resolution.xy))) { return; }
let n=u32(u.output.z);
var farthest=0.0;
for(var y=0u;y<n;y++) { for(var x=0u;x<n;x++) {
let p=id.xy*n+vec2u(x,y);
if(all(p<vec2u(u.output.xy))) {
let z=textureLoad(source,vec2i(p),0);
farthest=max(farthest,select(1e30,viewDepth(z),z>0.0));
}
} }
hiz[id.y*u32(u.resolution.x)+id.x]=farthest;
}
`;

export const GPS_LINEAR_DEPTH = wgsl`
${GPS_UNIFORMS}${SCREEN}
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read> screen:array<Screen>;
struct Vertex {
@builtin(position) position:vec4f,
@location(0) @interpolate(flat) index:u32,
}
@vertex fn vs(@builtin(vertex_index) vertex:u32,@builtin(instance_index) index:u32)->Vertex {
let s=screen[index];
if(s.color.a<=0.0) { return Vertex(vec4f(0.0,0.0,2.0,1.0),index); }
let corner=vec2f(f32(vertex&1u),f32(vertex>>1u))*2.0-1.0;
let radius=sqrt(2.0*s.color.a)*vec2f(s.conicChol.y,length(s.conicChol.zw));
let pixel=s.meanConic.xy+corner*radius;
let z=s.color.x;
let depth=(u.projection[2].z*z+u.projection[3].z)/(u.projection[2].w*z+u.projection[3].w);
return Vertex(vec4f(pixel/u.output.xy*vec2f(2.0,-2.0)+vec2f(-1.0,1.0),depth,1.0),index);
}
@fragment fn fs(v:Vertex) {
let s=screen[v.index];
let delta=v.position.xy-s.meanConic.xy;
let distance=s.meanConic.z*delta.x*delta.x+2.0*s.meanConic.w*delta.x*delta.y+s.conicChol.x*delta.y*delta.y;
if(distance>2.0*s.color.a) { discard; }
}
`;

export const GPS_HIZ = wgsl`
struct Level { source:vec4u, destination:vec4u }
@group(0) @binding(0) var<uniform> u:Level;
@group(0) @binding(1) var<storage,read_write> hiz:array<f32>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u) {
if(any(id.xy>=u.destination.yz)) { return; }
let begin=id.xy*2u;
let end=select(min(begin+2u,u.source.yz),u.source.yz,id.xy==u.destination.yz-1u);
var farthest=0.0;
for(var y=begin.y;y<end.y;y++) { for(var x=begin.x;x<end.x;x++) {
farthest=max(farthest,hiz[u.source.x+y*u.source.y+x]);
} }
hiz[u.destination.x+id.y*u.destination.y+id.x]=farthest;
}
`;

export const GPS_COMPOSITE = wgsl`
${GPS_UNIFORMS}
@group(1) @binding(0) var<uniform> u:Params;
@group(1) @binding(1) var<storage,read> accum:array<vec4f>;
@group(1) @binding(2) var<storage,read> depth:array<f32>;
struct Vertex { @builtin(position) position:vec4f, @location(0) uv:vec2f }
@vertex fn vs(@builtin(vertex_index) i:u32)->Vertex {
let xy=vec2f(f32((i<<1u)&2u),f32(i&2u));
return Vertex(vec4f(xy*2.0-1.0,0.0,1.0),vec2f(xy.x,1.0-xy.y));
}
struct Fragment { @location(0) color:vec4f, @builtin(frag_depth) depth:f32 }
@fragment fn fs(v:Vertex)->Fragment {
let pixel=vec2u(clamp(v.uv,vec2f(0.0),vec2f(0.999999))*u.output.xy);
let i=pixel.y*u32(u.output.x)+pixel.x;
let sampleColor=accum[i];
if(sampleColor.a<0.0015) { discard; }
let z=depth[i];
return Fragment(sampleColor,z);
}
`;
