/** The synthetic font-weight offset's shader fragment — the *only* WGSL this feature owns.
 *
 *  Every statement here is incremental: it declares what the base Slug shader does not have
 *  (a weight varying, an inflated quad, a distance solver, a bounded nearest-contour band
 *  scan, a coverage override) and nothing the base shader already provides. The fill/winding
 *  classification, the band walk, the root solve, the dilation and the color write all stay
 *  in the one shared template (`slug-shader.ts`), which interpolates these strings at its
 *  named slots.
 *
 *  Reachable only from `set-font-weight-offset.ts`, so a consumer that never imports
 *  `setFontWeightOffset` never carries any of this text.
 *
 *  ── Why this fragment owns a complete scan ──────────────────────────────────────────
 *  The base band loops answer a *winding* question, not a *nearest contour* question, and
 *  both of their optimizations are unsound for distance:
 *
 *    1. They read exactly one h-band (the band containing the pixel's y) and one v-band.
 *       That is complete for a +x / +y ray, which never leaves its own band. It is not
 *       complete for distance — the nearest contour to a pixel near a band boundary is
 *       routinely in the adjacent band.
 *    2. Inside a band they `break` as soon as a curve's max-x is more than half a pixel
 *       behind the pixel (curves are sorted by descending max-x). Those curves cannot
 *       cross the ray — but curves to the *left* of the pixel are exactly the ones that
 *       can be nearest to it.
 *
 *  Folding a running minimum into those loops therefore skips curves left of and below the
 *  pixel, which clips a positive (emboldening) offset on the right and top edges of a glyph
 *  and at all four corners. `wdst` below reads nothing from the base loops and does its own
 *  radius-bounded scan across every h-band the search radius touches. */

import type { TextShaderFragment } from "./text-shader-fragment.js";

/** @internal The font-weight offset fragment. `_id` is the variant field of the pipeline
 *  cache key and the suffix of the composed shader modules' labels. */
export const WEIGHT_SHADER_FRAGMENT: TextShaderFragment = {
    _id: "w",
    _vertexSlots: {
        VO: `@location(4) @interpolate(flat) wo:f32,`,
        VD: `d.wo=0.0;`,
        // Inflate by the miter limit so every accepted apex remains inside the quad.
        VB: `let wo=sy.p.y;
let ao=2.5*wo;
let sb=vec4<f32>(md.b.xy-vec2<f32>(ao),md.b.zw+vec2<f32>(ao));`,
        VA: `out.wo=wo;`,
    },
    _fragmentSlots: {
        FI: `@location(4) @interpolate(flat) wo:f32,`,
        FH: `fn dot2(v:vec2<f32>)->f32{return dot(v,v);}
// Exact distance from a point to a quadratic Bezier: solve the depressed cubic for the
// closest-point parameter, clamped to the segment.
fn dq(p:vec2<f32>,A:vec2<f32>,B:vec2<f32>,C:vec2<f32>)->f32{
let a=B-A;
let b=A-2.0*B+C;
let c=a*2.0;
let d=A-p;
let bb=dot(b,b);
// Degenerate (the control point is collinear/coincident): distance to the segment A->C.
if(bb<1.0e-7){
let ba=C-A;
let t=clamp(dot(p-A,ba)/max(dot(ba,ba),1.0e-9),0.0,1.0);
return length((A+ba*t)-p);
}
let kk=1.0/bb;
let kx=kk*dot(a,b);
let ky=kk*(2.0*dot(a,a)+dot(d,b))/3.0;
let kz=kk*dot(d,a);
var res:f32;
let pp=ky-kx*kx;
let pp3=pp*pp*pp;
let q=kx*(2.0*kx*kx-3.0*ky)+kz;
let h=q*q+4.0*pp3;
if(h>=0.0){
// One real root: Cardano.
let hh=sqrt(h);
let x=(vec2<f32>(hh,-hh)-q)/2.0;
let uv=sign(x)*pow(abs(x),vec2<f32>(1.0/3.0));
let t=clamp(uv.x+uv.y-kx,0.0,1.0);
res=dot2(d+(c+b*t)*t);
}else{
// Three real roots: trigonometric form; two of them can be the closest point.
let z=sqrt(-pp);
let v=acos(q/(pp*z*2.0))/3.0;
let m=cos(v);
let n=sin(v)*1.732050808;
let t=clamp(vec3<f32>(m+m,-n-m,n-m)*z-kx,vec3<f32>(0.0),vec3<f32>(1.0));
res=min(dot2(d+(c+b*t.x)*t.x),dot2(d+(c+b*t.y)*t.y));
}
return sqrt(res);
}
fn cr(a:vec2<f32>,b:vec2<f32>)->f32{return a.x*b.y-a.y*b.x;}
fn ds(p:vec2<f32>,a:vec2<f32>,b:vec2<f32>)->f32{
let e=b-a;
let v=p-a;
let q=v-e*clamp(dot(v,e)/max(dot(e,e),1.0e-9),0.0,1.0);
return dot(q,q);
}
// Signed distance to a triangle, negative inside. Degenerate joins contribute nothing.
fn td(p:vec2<f32>,a:vec2<f32>,b:vec2<f32>,c:vec2<f32>)->f32{
let ar=cr(b-a,c-a);
if(abs(ar)<1.0e-7){return 1.0e9;}
let inside=cr(b-a,p-a)*ar>=0.0&&cr(c-b,p-b)*ar>=0.0&&cr(a-c,p-c)*ar>=0.0;
let d=sqrt(min(ds(p,a,b),min(ds(p,b,c),ds(p,c,a))));
return select(d,-d,inside);
}
// Reconstruct the one convex, exterior-facing wedge from its stored unit apex vector.
fn mdst(p:vec2<f32>,A:vec2<f32>,B:vec2<f32>,C:vec2<f32>,m:vec2<f32>,wo:f32)->f32{
let ml=dot(m,m);
var tv=C-B;
if(dot(tv,tv)<1.0e-12){tv=C-A;}
if(ml<1.0e-7||dot(tv,tv)<1.0e-12){return 1.0e9;}
let t=normalize(tv);
var n=vec2<f32>(-t.y,t.x);
n=n*select(-1.0,1.0,dot(n,m)>=0.0);
let u=m*inverseSqrt(ml);
let nn=2.0*dot(n,u)*u-n;
let a=C+n*wo;
let b=C+nn*wo;
let ap=C+m*wo;
return td(p,a,ap,b);
}
struct WD{d:f32,m:f32};
// Distance from the pixel to the nearest contour and miter wedge within rad font units.
//
// Every h-band spans the full glyph width and partitions y, and a band lists every curve
// whose y-extent meets it (glyph-storage.ts -> buildBandsInternal). Any curve with a point
// within rad of the pixel has that point inside the glyph's y-bounds, so its band index
// lies in the clamped range below and the curve is in that band's list. The band transform
// (bn.y, bn.w) is monotone non-decreasing and never negative by construction there, so the
// two ends of the range stay ordered; a zero scale (zero-height glyph) collapses them to
// band 0, its only band.
fn wdst(rc:vec2<f32>,gp:vec2<i32>,bm:vec2<i32>,bn:vec4<f32>,rad:f32,wo:f32)->WD{
let y0=clamp(i32((rc.y-rad)*bn.y+bn.w),0,bm.y);
let y1=clamp(i32((rc.y+rad)*bn.y+bn.w),0,bm.y);
let xl=rc.x-rad;
var md=1.0e9;
var mm=1.0e9;
for(var b:i32=y0;b<=y1;b=b+1){
let hr=textureLoad(bt,vec2<i32>(gp.x+b,gp.y),0);
let hn=i32(hr.x+0.5);
let hl=bloc(gp,i32(hr.y+0.5));
for(var i:i32=0;i<hn;i=i+1){
let lr=textureLoad(bt,vec2<i32>(hl.x+i,hl.y),0);
let cv=vec2<i32>(i32(lr.x+0.5),i32(lr.y+0.5));
let q12=textureLoad(ct,cv,0);
let q3=textureLoad(ct,vec2<i32>(cv.x+1,cv.y),0);
// Curves are sorted by descending max-x: once one's right extent is farther left than
// the search radius, so is every later curve in this band. A curve with a point within
// rad has max-x >= rc.x - rad, so it is never behind this bound.
if(max(max(q12.x,q12.z),q3.x)<xl){break;}
md=min(md,dq(rc,q12.xy,q12.zw,q3.xy));
mm=min(mm,mdst(rc,q12.xy,q12.zw,q3.xy,q3.zw,wo));
}
}
return WD(md,mm);
}`,
        // Expand coverage outward from the nearest contour, then union it with the analytic
        // base coverage. `max` keeps the base authoritative inside the original fill, so an
        // overestimated distance can never punch a hole into the glyph. The `wo != 0` guard
        // means a stale or zero style entry in a variant group renders exactly as the base
        // shader and skips the scan.
        CO: `if(in.wo!=0.0){
let aas=max(max(pe.x,pe.y),1.0e-8);
let wd=wdst(rc,gp,bm,in.bn,2.5*in.wo+1.0/aas,in.wo);
let wc=clamp((in.wo-wd.d)*aas+0.5,0.0,1.0);
let mc=clamp(0.5-wd.m*aas,0.0,1.0);
cov=max(cov,max(wc,mc));
}`,
    },
};
