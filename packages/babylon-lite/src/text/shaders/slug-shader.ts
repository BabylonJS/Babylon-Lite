/** Slug GPU font shader — the single authoritative copy of the base vertex and fragment
 *  WGSL, plus the deterministic builder that composes an optional `TextShaderFragment`
 *  into it.
 *
 *  Direct port of Eric Lengyel's Slug algorithm (https://github.com/EricLengyel/Slug):
 *  the curve+band atlas layout, the per-pixel band walk, the Loop-Blinn 3-bit root-code
 *  table (`0x2E74`) and the screen-space dilation math all come from that reference.
 *
 *  ── Why an inline template rather than `?raw` .wgsl files ──────────────────────────
 *  Production bundles minify WGSL: `?raw` imports lose their comments entirely, so a
 *  comment-marker-based or regex-based injection would work in dev and silently break in
 *  a bundle. Composing known strings with `${}` interpolation at module scope
 *  cannot break that way (GUIDANCE: "Never parse emitted WGSL strings"). Inline WGSL
 *  templates are whitespace/comment-minified by `scripts/wgsl-minify-plugin.ts`, so the
 *  comments below are free in a production bundle.
 *
 *  ── Identifier legend ───────────────────────────────────────────────────────────────
 *  Identifiers are short because this text ships verbatim in every text-using bundle and
 *  `?raw`-file identifier mangling is not available to an inline template. Same
 *  convention as the Standard/PBR inline templates (`mat.dc`, `out.vp`, ...).
 *
 *    tu / TU    text uniform block: mvp | vp (viewport) | col (whole-draw opacity + gamma)
 *    gm / GM    per-glyph metadata: b (em-space bounds) | a (atlas loc + band maxima) | t (band transform)
 *    sty / TS   per-style entry: col (rgba) | p (params: x = invScale, y = optional style param)
 *    cn an pk   vertex inputs: corner sign | instance anchor | packed glyph + style index
 *    tc bn ga cl   varyings: dilated texcoord | band transform | glyph atlas | color
 *    ct bt      fragment textures: curve texels | band texels
 *    md sy      the instance's glyph metadata / style entry
 *    rc pe      em-space render coord | pixels-per-em (screen-space derivative)
 *    gp bm bi   glyph texel origin | max band index | this pixel's band index
 *    xc xw yc yw   horizontal/vertical signed coverage + weight accumulators
 *    cv p12 p3  curve texel location | first two control points | third control point
 *    cov        final coverage in [0,1] */

import type { TextShaderFragment } from "./text-shader-fragment.js";

/** @internal Composed WGSL pair for one shader variant. */
export interface ComposedSlugShader {
    /** @internal Vertex stage WGSL. */
    readonly _vert: string;
    /** @internal Fragment stage WGSL. */
    readonly _frag: string;
    /** @internal Composed fragment id — `""` for the base variant. Part of the pipeline cache key. */
    readonly _key: string;
}

/** Shared `TextU` block declaration — identical in both stages (same buffer, binding 0). */
const TEXT_UNIFORM = `struct TU{mvp:mat4x4<f32>,vp:vec4<f32>,col:vec4<f32>};
@group(0)@binding(0) var<uniform> tu:TU;`;

/** Compose the Slug shader pair.
 *
 *  `fragment === null` emits the base shader: every slot collapses to `""` and the bounds
 *  expression names `md.b` directly, so a base draw pays for no extra varying, helper or
 *  coverage override. There are no slots inside the band loops — see
 *  `text-shader-fragment.ts` for why a feature that needs a different traversal declares its
 *  own scan in `FH` instead. */
export function composeSlugShader(fragment: TextShaderFragment | null): ComposedSlugShader {
    const v = fragment?._vertexSlots;
    const f = fragment?._fragmentSlots;
    // `VB` must declare `let sb: vec4<f32>` (shaped bounds); without it the template reads
    // the glyph's own bounds, which keeps the base variant byte-for-byte free of the seam.
    const bounds = v?.VB ? "sb" : "md.b";

    const _vert = `${TEXT_UNIFORM}
struct GM{b:vec4<f32>,a:vec4<f32>,t:vec4<f32>};
@group(0)@binding(3) var<storage,read> gm:array<GM>;
struct TS{col:vec4<f32>,p:vec4<f32>};
@group(0)@binding(4) var<storage,read> sty:array<TS>;
struct VIn{@location(0) cn:vec2<f32>,@location(1) an:vec2<f32>,@location(2) pk:u32};
struct VOut{
@builtin(position) pos:vec4<f32>,
@location(0) tc:vec2<f32>,
@location(1) @interpolate(flat) bn:vec4<f32>,
@location(2) @interpolate(flat) ga:vec4<f32>,
@location(3) @interpolate(flat) cl:vec4<f32>,
${v?.VO ?? ""}
};
@vertex fn main(in:VIn)->VOut{
// Dead-slot sentinel: the allocator marks freed slots with an all-ones packed word (a live
// slot always holds a real index in each half). Collapse the quad to one off-screen point so
// the rasterizer culls six zero-area triangles cheaply.
if(in.pk==0xffffffffu){
var d:VOut;
d.pos=vec4<f32>(-2.0,-2.0,-2.0,1.0);
d.tc=vec2<f32>(0.0);
d.bn=vec4<f32>(0.0);
d.ga=vec4<f32>(0.0);
d.cl=vec4<f32>(0.0);
${v?.VD ?? ""}
return d;
}
let md=gm[in.pk&0xffffu];
let sy=sty[in.pk>>16u];
${v?.VB ?? ""}
// Reconstruct the corner from the shared unit quad: em-space bounds -> object-space pixels.
// The corner sign doubles as the dilation direction, so it needs no separate attribute.
let im=step(vec2<f32>(0.0),in.cn);
let tx=mix(${bounds}.xy,${bounds}.zw,im);
let iv=sy.p.x;
let sf=select(0.0,1.0/iv,iv!=0.0);
let ps=in.an+tx*sf;
let m=tu.mvp;
// MVP rows out of column-major storage. Only the xy and w terms are ever used, so each row
// is kept as a vec3 of (x, y, w).
let r0=vec3<f32>(m[0].x,m[1].x,m[3].x);
let r1=vec3<f32>(m[0].y,m[1].y,m[3].y);
let r3=vec3<f32>(m[0].w,m[1].w,m[3].w);
// Dynamic dilation (SlugDilate): expand the quad by exactly one fragment in screen space,
// and carry the same expansion into the texcoord through the inverse glyph Jacobian — which
// is the diagonal (iv, iv), so the transform is a plain scale.
let n=normalize(in.cn);
let s=dot(r3.xy,ps)+r3.z;
let t=dot(r3.xy,n);
let u=(s*dot(r0.xy,n)-t*(dot(r0.xy,ps)+r0.z))*tu.vp.x;
let vv=(s*dot(r1.xy,n)-t*(dot(r1.xy,ps)+r1.z))*tu.vp.y;
let uv=u*u+vv*vv;
let q=s*t;
let dl=in.cn*(s*s*(q+sqrt(uv))/(uv-q*q));
var out:VOut;
out.pos=m*vec4<f32>(ps+dl,0.0,1.0);
out.tc=tx+dl*iv;
out.bn=md.t;
out.ga=md.a;
// Color comes entirely from the style entry; the uniform contributes only whole-draw
// opacity (tu.col is always (gamma,1,1,opacity)).
out.cl=vec4<f32>(sy.col.rgb,sy.col.a*tu.col.a);
${v?.VA ?? ""}
return out;
}`;

    const _frag = `@group(0)@binding(1) var ct:texture_2d<f32>;
@group(0)@binding(2) var bt:texture_2d<f32>;
${TEXT_UNIFORM}
// Pipeline-overridable: when true, output straight (non-premultiplied) alpha so the hardware
// can derive sample coverage from alpha alone. Keyed by number (@id(0)) because a JS-side
// unquoted \`a2c\` key would be property-mangled by Closure ADVANCED while this text kept
// \`a2c\`, breaking pipeline creation for A2C consumers.
@id(0) override a2c:bool=false;
struct FIn{
@location(0) tc:vec2<f32>,
@location(1) @interpolate(flat) bn:vec4<f32>,
@location(2) @interpolate(flat) ga:vec4<f32>,
@location(3) @interpolate(flat) cl:vec4<f32>,
${f?.FI ?? ""}
@builtin(front_facing) ff:bool
};
// Loop-Blinn root code: which of the two quadratic roots cross the ray, from the sign
// pattern of the three control-point ordinates.
fn rcode(y1:f32,y2:f32,y3:f32)->i32{
let s=u32(select(0,1,y1<0.0)+select(0,2,y2<0.0)+select(0,4,y3<0.0));
return (0x2E74>>s)&0x0101;
}
// Both solvers return the two ray/curve intersection ordinates; they differ only in which
// axis is the ray axis (kept as two functions so neither pays a branch per curve).
fn solveH(p12:vec4<f32>,p3:vec2<f32>)->vec2<f32>{
let a=vec2<f32>(p12.x-p12.z*2.0+p3.x,p12.y-p12.w*2.0+p3.y);
let b=vec2<f32>(p12.x-p12.z,p12.y-p12.w);
let ra=1.0/a.y;
let rb=0.5/b.y;
let dc=sqrt(max(b.y*b.y-a.y*p12.y,0.0));
var t1=(b.y-dc)*ra;
var t2=(b.y+dc)*ra;
// Near-linear curve: the quadratic term is numerically noise, so take the linear root twice.
if(abs(a.y)<=max(abs(b.y),abs(p12.y))*1.0e-4){
t1=p12.y*rb;
t2=p12.y*rb;
}
return vec2<f32>((a.x*t1-b.x*2.0)*t1+p12.x,(a.x*t2-b.x*2.0)*t2+p12.x);
}
fn solveV(p12:vec4<f32>,p3:vec2<f32>)->vec2<f32>{
let a=vec2<f32>(p12.x-p12.z*2.0+p3.x,p12.y-p12.w*2.0+p3.y);
let b=vec2<f32>(p12.x-p12.z,p12.y-p12.w);
let ra=1.0/a.x;
let rb=0.5/b.x;
let dc=sqrt(max(b.x*b.x-a.x*p12.x,0.0));
var t1=(b.x-dc)*ra;
var t2=(b.x+dc)*ra;
if(abs(a.x)<=max(abs(b.x),abs(p12.x))*1.0e-4){
t1=p12.x*rb;
t2=p12.x*rb;
}
return vec2<f32>((a.y*t1-b.y*2.0)*t1+p12.y,(a.y*t2-b.y*2.0)*t2+p12.y);
}
// Per-root coverage and edge weight, shared by both band loops: how much of the pixel the
// crossing covers, and how perpendicular the ray was to the contour it crossed.
fn ccov(r:f32)->f32{return clamp(r+0.5,0.0,1.0);}
fn cwgt(r:f32)->f32{return clamp(1.0-abs(r)*2.0,0.0,1.0);}
// Band lists wrap at 4096 texels; fold the overflow into the next texture row.
fn bloc(g:vec2<i32>,o:i32)->vec2<i32>{
let x=g.x+o;
return vec2<i32>(x&4095,g.y+(x>>12u));
}
${f?.FH ?? ""}
@fragment fn main(in:FIn)->@location(0) vec4<f32>{
// Text quads are one-sided sheets of paper: without this the back of a rotated quad shows
// geometrically correct mirror-image text. Double-sided readable text uses a second
// renderable rotated 180 degrees.
if(!in.ff){discard;}
let rc=in.tc;
let pe=1.0/fwidth(rc);
let gp=vec2<i32>(i32(in.ga.x+0.5),i32(in.ga.y+0.5));
let bm=vec2<i32>(i32(in.ga.z+0.5),i32(in.ga.w+0.5));
let bi=clamp(vec2<i32>(rc*in.bn.xy+in.bn.zw),vec2<i32>(0),bm);
var xc=0.0;
var xw=0.0;
var yc=0.0;
var yw=0.0;
// Horizontal band: signed crossings of the +x ray through this pixel.
let hr=textureLoad(bt,vec2<i32>(gp.x+bi.y,gp.y),0);
let hn=i32(hr.x+0.5);
let hl=bloc(gp,i32(hr.y+0.5));
for(var i:i32=0;i<hn;i=i+1){
let lr=textureLoad(bt,bloc(hl,i),0);
let cv=vec2<i32>(i32(lr.x+0.5),i32(lr.y+0.5));
let p12=textureLoad(ct,cv,0)-vec4<f32>(rc,rc);
let p3=textureLoad(ct,vec2<i32>(cv.x+1,cv.y),0).xy-rc;
// Curves are sorted along the band axis: once one is fully behind the pixel, so are the rest.
if(max(max(p12.x,p12.z),p3.x)*pe.x < -0.5){break;}
let cd=rcode(p12.y,p12.w,p3.y);
if(cd!=0){
let r=solveH(p12,p3)*pe.x;
if((cd&1)!=0){
xc=xc+ccov(r.x);
xw=max(xw,cwgt(r.x));
}
if(cd>1){
xc=xc-ccov(r.y);
xw=max(xw,cwgt(r.y));
}
}
}
// Vertical band: same walk along +y (signs mirrored).
let vr=textureLoad(bt,vec2<i32>(gp.x+bm.y+1+bi.x,gp.y),0);
let vn=i32(vr.x+0.5);
let vl=bloc(gp,i32(vr.y+0.5));
for(var i:i32=0;i<vn;i=i+1){
let lr=textureLoad(bt,bloc(vl,i),0);
let cv=vec2<i32>(i32(lr.x+0.5),i32(lr.y+0.5));
let p12=textureLoad(ct,cv,0)-vec4<f32>(rc,rc);
let p3=textureLoad(ct,vec2<i32>(cv.x+1,cv.y),0).xy-rc;
if(max(max(p12.y,p12.w),p3.y)*pe.y < -0.5){break;}
let cd=rcode(p12.x,p12.z,p3.x);
if(cd!=0){
let r=solveV(p12,p3)*pe.y;
if((cd&1)!=0){
yc=yc-ccov(r.x);
yw=max(yw,cwgt(r.x));
}
if(cd>1){
yc=yc+ccov(r.y);
yw=max(yw,cwgt(r.y));
}
}
}
// Blend the two axes by how perpendicular each ray was to the contour it crossed, and never
// report less than the weaker axis alone (thin stems).
var cov=max(abs(xc*xw+yc*yw)/max(xw+yw,1.0/65536.0),min(abs(xc),abs(yc)));
cov=clamp(cov,0.0,1.0);
${f?.CO ?? ""}
// Coverage gamma: raise edge coverage to 1/coverageGamma so anti-aliased edges composite
// heavier (mimics gamma-space stem darkening). tu.col.x is 1 by default (no-op).
cov=pow(cov,tu.col.x);
// a2c false -> RGB is coverage-weighted (premultiplied). a2c true -> coverage lives in alpha only.
let rw=select(cov,1.0,a2c);
return vec4<f32>(in.cl.rgb*rw,in.cl.a*cov);
}`;

    return { _vert, _frag, _key: fragment?._id ?? "" };
}
