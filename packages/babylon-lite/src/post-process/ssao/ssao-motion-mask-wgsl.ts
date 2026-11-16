import { wgsl, type WgslSource } from "../../shader/wgsl.js";
import { SSAO_PARAMS_WGSL, ssaoDepthBindingWGSL } from "./ssao-wgsl.js";
import { SSAO_TEMPORAL_PARAMS_WGSL } from "./ssao-xegtao-wgsl.js";

/**
 * @internal Geometry of the conservative tile-bounds pyramid. Level 0 has one cell per 8x8
 * receiver tile; each coarser level halves (floor, minimum one) and its last cell also covers
 * the odd remainder, exactly as a 2x2 reduction with stretched edges would.
 */
export function ssaoMotionMaskLevelsWGSL(): WgslSource {
    return wgsl`fn motionLevelDims(m:u32)->vec2u{return max(((ao.size+7u)/8u)>>vec2u(m),vec2u(1));}
fn motionLevels()->u32{let base=(ao.size+7u)/8u;return firstLeadingBit(max(base.x,base.y))+1u;}`;
}

/** Number of 4-word cells in every pyramid level for a receiver size. */
export function ssaoMotionMaskCellCount(width: number, height: number): number {
    const x = Math.ceil(width / 8),
        y = Math.ceil(height / 8),
        levels = Math.floor(Math.log2(Math.max(x, y))) + 1;
    let cells = 0;
    for (let m = 0; m < levels; m++) {
        cells += Math.max(1, x >> m) * Math.max(1, y >> m);
    }
    return cells;
}

/**
 * @internal Mark one moving tile in every level with atomics. Cells store (~lowerX, ~lowerY,
 * upperX, upperY), so a zero-cleared buffer is the empty rectangle and max() unions bounds.
 */
export function ssaoMotionMaskMarkWGSL(binding: number): WgslSource {
    return wgsl`@group(0) @binding(${binding}) var<storage,read_write> motionCells:array<atomic<u32>>;
${ssaoMotionMaskLevelsWGSL()}
fn markMovingTile(tile:vec2u){
let lower=tile*8u;let upper=min(lower+7u,ao.size-1u);
var offset=0u;let levels=motionLevels();
for(var m=0u;m<levels;m++){
let dims=motionLevelDims(m);let cell=min(tile>>vec2u(m),dims-1u);let i=(offset+cell.y*dims.x+cell.x)*4u;
atomicMax(&motionCells[i],~lower.x);atomicMax(&motionCells[i+1u],~lower.y);
atomicMax(&motionCells[i+2u],upper.x);atomicMax(&motionCells[i+3u],upper.y);
offset+=dims.x*dims.y;
}
}`;
}

/** @internal Conservative receiver search bounds, including stretched odd edges. */
export function ssaoMotionMaskQueryWGSL(): WgslSource {
    return wgsl`@group(0) @binding(8) var<storage,read> motionCells:array<u32>;
${ssaoMotionMaskLevelsWGSL()}
fn movingCaster(pixel:vec2f,radius:f32)->bool{
let span=max(1.0,(radius*2.0+2.0)/8.0);
let mip=u32(clamp(ceil(log2(span)),0.0,f32(motionLevels()-1u)));
var offset=0u;for(var m=0u;m<mip;m++){let d=motionLevelDims(m);offset+=d.x*d.y;}
let dims=motionLevelDims(mip);let scale=8.0*exp2(f32(mip));
let first=aoClamp(vec2i(floor((pixel-radius-1.0)/scale)),dims);
let last=aoClamp(vec2i(floor((pixel+radius+1.0)/scale)),dims);
let lower=vec2u(aoClamp(vec2i(floor(pixel-radius-1.0)),ao.size));
let upper=vec2u(aoClamp(vec2i(floor(pixel+radius+1.0)),ao.size));
for(var y=first.y;y<=last.y;y++){for(var x=first.x;x<=last.x;x++){
let i=(offset+u32(y)*dims.x+u32(x))*4u;
let cellLower=~vec2u(motionCells[i],motionCells[i+1u]);let cellUpper=vec2u(motionCells[i+2u],motionCells[i+3u]);
if(all(cellLower<=upper)&&all(cellUpper>=lower)){return true;}
}}return false;
}`;
}

/** @internal Conservative camera-relative material motion; one dispatch fills every level. */
export function ssaoMotionMaskWGSL(kind: "depth" | "float"): WgslSource {
    return wgsl`${SSAO_PARAMS_WGSL}
${ssaoDepthBindingWGSL(kind, 1)}
@group(0) @binding(2) var velocity:texture_2d<f32>;
${SSAO_TEMPORAL_PARAMS_WGSL}
@group(0) @binding(3) var<uniform> t:Temporal;
${ssaoMotionMaskMarkWGSL(4)}
@group(0) @binding(5) var<storage,read_write> draw:array<atomic<u32>,4>;
// Workgroup memory starts zeroed, so the flag needs no clearing barrier.
var<workgroup> moved:atomic<u32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(workgroup_id) tile:vec3u,@builtin(local_invocation_index) local:u32){
if(all(id.xy<ao.size)&&t.control.x==0.0){
// Velocity is fetched with depth rather than after the background test.
let p=vec2i(id.xy);let depth=aoRawDepth(p);let supplied=textureLoad(velocity,p,0);
if(depth>0.0){
let uv=(vec2f(id.xy)+0.5)*ao.invSize;
let h=t.invVP*vec4f(uv*vec2f(2,-2)+vec2f(-1,1),depth,1);
let clip=t.previousVP*vec4f(h.xyz/h.w,1);
let cameraUv=vec2f(clip.x/clip.w*0.5+0.5,0.5-clip.y/clip.w*0.5);
let oldUv=uv+supplied.xy*vec2f(1,-1);
// Half the transport's static thresholds, so a skipped tile can never hold a caster it would move.
if(!(length((oldUv-cameraUv)*vec2f(ao.size))<0.025+length(supplied.xy*vec2f(ao.size))*t.tolerance.y*0.5)||
(t.control.w!=0.0&&abs(supplied.z-clip.w)>max(1e-4,abs(clip.w)*t.tolerance.x))){atomicOr(&moved,1u);}
}}
workgroupBarrier();
if(local==0u&&atomicLoad(&moved)!=0u){
markMovingTile(tile.xy);
atomicStore(&draw[0],3u);atomicStore(&draw[1],1u);
}
}`;
}
