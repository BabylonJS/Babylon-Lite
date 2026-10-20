/**
 * Experimental temporal reprojection for Gaussian point splatting, loaded on demand when
 * `temporalReprojection` is enabled so scenes without it do not pay for the shaders.
 * @internal
 */
import { BU } from "../engine/gpu-flags.js";
import { invertMat4 } from "../math/invert-mat4.js";
import { multiplyMat4 } from "../math/multiply-mat4.js";
import type { Mat4 } from "../math/types.js";
import { wgsl, type WgslSource } from "../shader/wgsl.js";

// Experimental temporal reprojection. m maps the previous frame's NDC (pixel center, stored depth) to the current clip space;
// info is (full width, full height, generation, history cap). Nearest keys are ~bits(clip.w), so atomicMax keeps the closest.
const REPROJECT = wgsl`
struct Reproject { m:mat4x4f, info:vec4f }
@group(0) @binding(0) var<uniform> r:Reproject;
fn reprojected(p:u32, z:f32)->vec4f {
let size=u32(r.info.x);
let ndc=(vec2f(f32(p%size),f32(p/size))+0.5)/r.info.xy*2.0-1.0;
return r.m*vec4f(ndc.x,-ndc.y,z,1.0);
}
fn destination(clip:vec4f)->u32 {
let px=(vec2f(clip.x,-clip.y)/clip.w*0.5+0.5)*r.info.xy;
if(clip.w>1e-6 && all(px>=vec2f(0.0)) && all(px<r.info.xy)) { return u32(px.y)*u32(r.info.x)+u32(px.x); }
return 0xffffffffu;
}
`;

/** Forward scatter of the previous accumulation: nearest depth first, then the winning source pixel. */
function scatterShader(source: boolean): WgslSource {
    return wgsl`
${REPROJECT}
@group(0) @binding(1) var<storage,read> prevDepth:array<f32>;
@group(0) @binding(2) var<storage,read> prevCounts:array<u32>;
${
    source
        ? wgsl`@group(0) @binding(3) var<storage,read> nearest:array<u32>;
@group(0) @binding(4) var<storage,read_write> winner:array<atomic<u32>>;`
        : wgsl`@group(0) @binding(3) var<storage,read_write> nearest:array<atomic<u32>>;`
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u) {
if(any(id.xy>=vec2u(r.info.xy))) { return; }
let p=id.y*u32(r.info.x)+id.x;
let z=prevDepth[p];
let count=prevCounts[p];
if((count>>16u)!=u32(r.info.z) || (count&65535u)==0u || z<=0.0) { return; }
let clip=reprojected(p,z);
let d=destination(clip);
if(d==0xffffffffu) { return; }
let key=~bitcast<u32>(clip.w);
${source ? wgsl`if(nearest[d]==key) { atomicMax(&winner[d],p+1u); }` : wgsl`atomicMax(&nearest[d],key);`}
}
`;
}

/** Rebuilds the accumulation from scattered sources; fills magnification cracks and holes from neighbors. */
const GATHER = wgsl`
${REPROJECT}
@group(0) @binding(1) var<storage,read> nearest:array<u32>;
@group(0) @binding(2) var<storage,read> winner:array<u32>;
@group(0) @binding(3) var<storage,read> prevAccum:array<vec4f>;
@group(0) @binding(4) var<storage,read> prevDepth:array<f32>;
@group(0) @binding(5) var<storage,read> prevCounts:array<u32>;
@group(0) @binding(6) var<storage,read_write> accum:array<vec4f>;
@group(0) @binding(7) var<storage,read_write> depth:array<f32>;
@group(0) @binding(8) var<storage,read_write> counts:array<u32>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u) {
let size=vec2u(r.info.xy);
if(any(id.xy>=size)) { return; }
let d=id.y*size.x+id.x;
let own=nearest[d];
var closest=0u; var nearSource=0u; var farthest=0xffffffffu; var farSource=0u; var nearer=0u;
for(var y=-1;y<=1;y++) { for(var x=-1;x<=1;x++) {
let q=vec2i(id.xy)+vec2i(x,y);
if((x!=0 || y!=0) && all(q>=vec2i(0)) && all(q<vec2i(size))) {
let n=u32(q.y)*size.x+u32(q.x);
let key=nearest[n];
if(key!=0u) {
if(key>closest) { closest=key; nearSource=winner[n]; }
if(key<farthest) { farthest=key; farSource=winner[n]; }
if(own!=0u && bitcast<f32>(~key)<0.9*bitcast<f32>(~own)) { nearer++; }
}
}
} }
var p=winner[d];
var filled=false;
// Background visible through a magnified foreground surface: most neighbors are clearly nearer.
if(nearer>=6u) { p=nearSource; filled=true; }
// Disocclusions usually reveal what lies behind, so holes borrow the farthest neighbor.
if(p==0u) { p=farSource; filled=true; }
let generation=u32(r.info.z)<<16u;
if(p==0u) { accum[d]=vec4f(0.0); depth[d]=0.0; counts[d]=generation; return; }
p-=1u;
let clip=reprojected(p,prevDepth[p]);
var count=min(prevCounts[p]&65535u,u32(r.info.w));
if(filled) { count=max(1u,count/2u); }
accum[d]=prevAccum[p];
depth[d]=clamp(clip.z/clip.w,0.0,1.0);
counts[d]=generation|count;
}
`;

interface Pipelines {
    nearest: GPUComputePipeline;
    winner: GPUComputePipeline;
    gather: GPUComputePipeline;
}

/** Previous-frame copies and scatter targets, allocated on the first reprojected frame. */
interface History {
    params: GPUBuffer;
    accum: GPUBuffer;
    depth: GPUBuffer;
    counts: GPUBuffer;
    nearest: GPUBuffer;
    winner: GPUBuffer;
}

/** Full-resolution accumulation buffers; history buffers are appended to `buffers` so they retire together. */
export interface GpsReprojectionTarget {
    accum: GPUBuffer;
    depth: GPUBuffer;
    counts: GPUBuffer;
    buffers: GPUBuffer[];
}

export type GpsReprojectionDispatch = (pipeline: GPUComputePipeline, resources: readonly GPUBuffer[], x: number, y: number) => void;

const pipelineCache = new WeakMap<GPUDevice, Pipelines>();
const historyCache = new WeakMap<GpsReprojectionTarget, History>();

/**
 * Maps the previous frame's NDC to the current clip space, or null when the previous transform is singular.
 * `matrices` packs the previous world, view and projection at offsets 0, 16 and 32.
 */
export function gpsReprojectionMatrix(matrices: Float32Array, world: Mat4, view: Mat4, projection: Mat4): Mat4 | null {
    const previous = invertMat4(
        multiplyMat4(multiplyMat4(matrices.subarray(32, 48) as unknown as Mat4, matrices.subarray(16, 32) as unknown as Mat4), matrices.subarray(0, 16) as unknown as Mat4)
    );
    return previous && multiplyMat4(multiplyMat4(multiplyMat4(projection, view), world), previous);
}

/** Remaps the accumulation in place. `params` holds the reprojection matrix followed by (width, height, generation, history cap). */
export function gpsRecordReprojection(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    target: GpsReprojectionTarget,
    params: Float32Array,
    createBuffer: (size: number, label: string, usage?: GPUBufferUsageFlags) => GPUBuffer,
    dispatch: GpsReprojectionDispatch
): void {
    const width = params[16]!;
    const height = params[17]!;
    const size = width * height;
    let history = historyCache.get(target);
    if (!history) {
        const buffers: GPUBuffer[] = [];
        const make = (bytes: number, label: string, usage?: GPUBufferUsageFlags): GPUBuffer => {
            const value = createBuffer(bytes, label, usage);
            buffers.push(value);
            return value;
        };
        try {
            history = {
                params: make(80, "reprojection parameters", BU.UNIFORM | BU.COPY_DST),
                accum: make(size * 16, "previous accumulation"),
                depth: make(size * 4, "previous depth"),
                counts: make(size * 4, "previous counts"),
                nearest: make(size * 4, "reprojection depth"),
                winner: make(size * 4, "reprojection source"),
            };
        } catch (error) {
            buffers.forEach((value) => value.destroy());
            throw error;
        }
        target.buffers.push(...buffers);
        historyCache.set(target, history);
    }
    let pipelines = pipelineCache.get(device);
    if (!pipelines) {
        const compute = (code: string, label: string): GPUComputePipeline =>
            device.createComputePipeline({
                label: `GPS ${label}`,
                layout: "auto",
                compute: { module: device.createShaderModule({ label: `GPS ${label}`, code }), entryPoint: "main" },
            });
        pipelines = {
            nearest: compute(scatterShader(false), "reproject nearest"),
            winner: compute(scatterShader(true), "reproject source"),
            gather: compute(GATHER, "reproject gather"),
        };
        pipelineCache.set(device, pipelines);
    }
    const x = Math.ceil(width / 8);
    const y = Math.ceil(height / 8);
    device.queue.writeBuffer(history.params, 0, params);
    encoder.copyBufferToBuffer(target.accum, 0, history.accum, 0, size * 16);
    encoder.copyBufferToBuffer(target.depth, 0, history.depth, 0, size * 4);
    encoder.copyBufferToBuffer(target.counts, 0, history.counts, 0, size * 4);
    encoder.clearBuffer(history.nearest);
    encoder.clearBuffer(history.winner);
    dispatch(pipelines.nearest, [history.params, history.depth, history.counts, history.nearest], x, y);
    dispatch(pipelines.winner, [history.params, history.depth, history.counts, history.nearest, history.winner], x, y);
    dispatch(pipelines.gather, [history.params, history.nearest, history.winner, history.accum, history.depth, history.counts, target.accum, target.depth, target.counts], x, y);
}
