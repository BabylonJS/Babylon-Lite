/** GPU frustum culling for opt-in thin instances.
 *
 * Dynamically imported only when a scene enables thin-instance GPU culling.
 * Each render binding owns its own state so render tasks with different cameras
 * never clobber one another's compacted instance buffers or indirect args.
 */

import { F32, U32 } from "../engine/typed-arrays.js";
import { BU } from "../engine/gpu-flags.js";
import type { Camera } from "../camera/camera.js";
import { getViewProjectionMatrix } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { DrawUpdateBatch, DrawUpdateContext } from "../render/renderable.js";
import type { Mat4 } from "../math/types.js";
import type { Mesh, MeshGPU } from "./mesh.js";
import type { ThinInstanceData } from "./thin-instance.js";
import { syncThinInstanceGpuData } from "./thin-instance-gpu.js";
import type { ThinInstanceDrawBuffers } from "./thin-instance-gpu.js";
import { bumpVisibilityEpoch } from "../engine/engine.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";

const WORKGROUP_SIZE = 64;
const PARAM_BYTES = 192;
// Two-bucket (LOD partner) params append camPosDist (vec4: camera xyz + threshold distance)
// and lodBand after the base struct's implicit 16-byte tail padding.
const LOD_PARAM_BYTES = 224;
const COUNT_U32_OFFSET = 44;
const MESH_WORLD_FLOAT_OFFSET = 24;
const LOCAL_SPHERE_FLOAT_OFFSET = 40;
const BOUNDS_PAD_F32_OFFSET = 45;
const CAM_POS_DIST_F32_OFFSET = 48;
const LOD_BAND_F32_OFFSET = 52;
const INDIRECT_ARGS_BYTES = 20;

const CULL_WGSL_NO_COLOR = /* wgsl */ `
struct CullParams{planes:array<vec4<f32>,6>,meshWorld:mat4x4<f32>,localSphere:vec4<f32>,count:u32,boundsPad:f32};
@group(0)@binding(0)var<storage,read> srcMatrices:array<mat4x4<f32>>;
@group(0)@binding(1)var<storage,read_write> dstMatrices:array<mat4x4<f32>>;
@group(0)@binding(2)var<storage,read_write> args:array<atomic<u32>>;
@group(0)@binding(3)var<uniform> params:CullParams;
fn visible(world:mat4x4<f32>)->bool{
let center=(world*vec4<f32>(params.localSphere.xyz,1.0)).xyz;
let sx=length(world[0].xyz);
let sy=length(world[1].xyz);
let sz=length(world[2].xyz);
let radius=params.localSphere.w*max(max(sx,sy),sz)+params.boundsPad+0.0001;
for(var i=0u;i<6u;i++){
let p=params.planes[i];
if(dot(p.xyz,center)+p.w < -radius){return false;}
}
return true;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid:vec3<u32>){
let i=gid.x;
if(i>=params.count){return;}
let world=params.meshWorld*srcMatrices[i];
if(!visible(world)){return;}
let outIndex=atomicAdd(&args[1],1u);
dstMatrices[outIndex]=srcMatrices[i];
}`;

const CULL_WGSL_COLOR = `${CULL_WGSL_NO_COLOR}
@group(0)@binding(4)var<storage,read> srcColors:array<vec4<f32>>;
@group(0)@binding(5)var<storage,read_write> dstColors:array<vec4<f32>>;
@compute @workgroup_size(64)
fn mainColor(@builtin(global_invocation_id) gid:vec3<u32>){
let i=gid.x;
if(i>=params.count){return;}
let world=params.meshWorld*srcMatrices[i];
if(!visible(world)){return;}
let outIndex=atomicAdd(&args[1],1u);
dstMatrices[outIndex]=srcMatrices[i];
dstColors[outIndex]=srcColors[i];
}`;

// Two-bucket variant used when the mesh has a LOD partner: in-frustum instances partition by camera
// distance — near keeps the mesh's own compacted bucket, far fills the partner's bucket. `isNear`
// dithers the threshold per instance by ±lodBand/2 via a pure hash of the instance index (PCG), so
// the split is deterministic frame-to-frame with no time or randomness input.
const CULL_WGSL_LOD_NO_COLOR = /* wgsl */ `
struct CullParams{planes:array<vec4<f32>,6>,meshWorld:mat4x4<f32>,localSphere:vec4<f32>,count:u32,boundsPad:f32,camPosDist:vec4<f32>,lodBand:f32};
@group(0)@binding(0)var<storage,read> srcMatrices:array<mat4x4<f32>>;
@group(0)@binding(1)var<storage,read_write> dstMatrices:array<mat4x4<f32>>;
@group(0)@binding(2)var<storage,read_write> args:array<atomic<u32>>;
@group(0)@binding(3)var<uniform> params:CullParams;
@group(0)@binding(6)var<storage,read_write> lodMatrices:array<mat4x4<f32>>;
@group(0)@binding(7)var<storage,read_write> lodArgs:array<atomic<u32>>;
fn visible(world:mat4x4<f32>)->bool{
let center=(world*vec4<f32>(params.localSphere.xyz,1.0)).xyz;
let sx=length(world[0].xyz);
let sy=length(world[1].xyz);
let sz=length(world[2].xyz);
let radius=params.localSphere.w*max(max(sx,sy),sz)+params.boundsPad+0.0001;
for(var i=0u;i<6u;i++){
let p=params.planes[i];
if(dot(p.xyz,center)+p.w < -radius){return false;}
}
return true;
}
fn isNear(world:mat4x4<f32>,i:u32)->bool{
let center=(world*vec4<f32>(params.localSphere.xyz,1.0)).xyz;
var h=i*747796405u+2891336453u;
h=((h>>((h>>28u)+4u))^h)*277803737u;
h=(h>>22u)^h;
let dither=(f32(h)*(1.0/4294967295.0)-0.5)*params.lodBand;
return distance(center,params.camPosDist.xyz)<params.camPosDist.w+dither;
}
@compute @workgroup_size(64)
fn mainLod(@builtin(global_invocation_id) gid:vec3<u32>){
let i=gid.x;
if(i>=params.count){return;}
let world=params.meshWorld*srcMatrices[i];
if(!visible(world)){return;}
if(isNear(world,i)){
let outIndex=atomicAdd(&args[1],1u);
dstMatrices[outIndex]=srcMatrices[i];
}else{
let outIndex=atomicAdd(&lodArgs[1],1u);
lodMatrices[outIndex]=srcMatrices[i];
}
}`;

const CULL_WGSL_LOD_COLOR = `${CULL_WGSL_LOD_NO_COLOR}
@group(0)@binding(4)var<storage,read> srcColors:array<vec4<f32>>;
@group(0)@binding(5)var<storage,read_write> dstColors:array<vec4<f32>>;
@group(0)@binding(8)var<storage,read_write> lodColors:array<vec4<f32>>;
@compute @workgroup_size(64)
fn mainLodColor(@builtin(global_invocation_id) gid:vec3<u32>){
let i=gid.x;
if(i>=params.count){return;}
let world=params.meshWorld*srcMatrices[i];
if(!visible(world)){return;}
if(isNear(world,i)){
let outIndex=atomicAdd(&args[1],1u);
dstMatrices[outIndex]=srcMatrices[i];
dstColors[outIndex]=srcColors[i];
}else{
let outIndex=atomicAdd(&lodArgs[1],1u);
lodMatrices[outIndex]=srcMatrices[i];
lodColors[outIndex]=srcColors[i];
}
}`;

/** Per-render-binding GPU culling state. */
export interface ThinInstanceGpuCullState {
    /** @internal */
    _capacity: number;
    /** @internal */
    _visibleMatrixBuffer: GPUBuffer | null;
    /** @internal */
    _visibleColorBuffer: GPUBuffer | null;
    /** @internal */
    _argsBuffer: GPUBuffer | null;
    /** @internal */
    _paramsBuffer: GPUBuffer | null;
    /** @internal */
    _bindGroup: GPUBindGroup | null;
    /** @internal */
    _srcMatrixBuffer: GPUBuffer | null;
    /** @internal */
    _srcColorBuffer: GPUBuffer | null;
    /** @internal */
    _hasColor: boolean;
    /** @internal */
    _localSphereReady: boolean;
    /** @internal CPU geometry reference used to build `_localSphere`. */
    _localPositions?: Float32Array;
    /** @internal Bounds references used to detect same-buffer geometry updates. */
    _localBoundMin?: Mesh["boundMin"];
    /** @internal Bounds references used to detect same-buffer geometry updates. */
    _localBoundMax?: Mesh["boundMax"];
    /** @internal */
    _localSphere: Float32Array;
    /** @internal */
    _paramsBytes: ArrayBuffer;
    /** @internal */
    _paramsF32: Float32Array;
    /** @internal */
    _paramsU32: Uint32Array;
    /** @internal */
    _argsData: Uint32Array;
    /** @internal */
    _drawBuffers: ThinInstanceDrawBuffers | null;
    /** @internal */
    _indexCount: number;
    /** @internal */
    _active: boolean;
    /** @internal Whether the current pipeline/bind-group/params target the two-bucket LOD variant. */
    _lodActive: boolean;
    /** @internal Far-bucket compacted matrices (two-bucket variant only). */
    _lodMatrixBuffer: GPUBuffer | null;
    /** @internal Far-bucket compacted colors (two-bucket variant with instance colors only). */
    _lodColorBuffer: GPUBuffer | null;
    /** @internal Far-bucket indirect draw args consumed by the LOD partner's draw. */
    _lodArgsBuffer: GPUBuffer | null;
    /** @internal Last index count (the partner mesh's) written to `_lodArgsBuffer`. */
    _lodIndexCount: number;
    /** @internal True once the far-bucket args were zeroed for a fallback frame (reset when culling runs). */
    _lodArgsZeroed: boolean;
}

/** Result consumed by a material draw closure after culling has run for the active pass. */
export interface ThinInstanceGpuCullResult {
    readonly drawBuffers: ThinInstanceDrawBuffers;
    readonly argsBuffer: GPUBuffer;
    /** Far-bucket compacted instance buffers for the LOD partner's draw (two-bucket variant only). */
    readonly lodDrawBuffers?: ThinInstanceDrawBuffers;
    /** Far-bucket indirect args for the LOD partner's draw (two-bucket variant only). */
    readonly lodArgsBuffer?: GPUBuffer;
}

interface ComputeDispatch {
    readonly pipeline: GPUComputePipeline;
    readonly bindGroup: GPUBindGroup;
    readonly workgroupsX: number;
}

/** @internal Task-local batch that submits all culling work through one compute pass. */
export interface ComputeDispatchBatch extends DrawUpdateBatch {
    queue(dispatch: ComputeDispatch): void;
}

let _cachedDevice: GPUDevice | null = null;
let _pipelineNoColor: GPUComputePipeline | null = null;
let _pipelineColor: GPUComputePipeline | null = null;
let _pipelineLodNoColor: GPUComputePipeline | null = null;
let _pipelineLodColor: GPUComputePipeline | null = null;
let _dispatchBatches: WeakMap<RenderTargetSignature, ComputeDispatchBatch> | null = null;

/** @internal Return the compute batch associated with one render task. */
export function getComputeDispatchBatch(signature: RenderTargetSignature): ComputeDispatchBatch {
    _dispatchBatches ??= new WeakMap();
    let batch = _dispatchBatches.get(signature);
    if (batch) {
        return batch;
    }
    const dispatches: ComputeDispatch[] = [];
    let count = 0;
    batch = {
        reset(): void {
            count = 0;
        },
        flush(engine): void {
            if (count === 0) {
                return;
            }
            const pass = engine._currentEncoder.beginComputePass();
            let lastPipeline: GPUComputePipeline | null = null;
            for (let i = 0; i < count; i++) {
                const dispatch = dispatches[i]!;
                if (dispatch.pipeline !== lastPipeline) {
                    pass.setPipeline(dispatch.pipeline);
                    lastPipeline = dispatch.pipeline;
                }
                pass.setBindGroup(0, dispatch.bindGroup);
                pass.dispatchWorkgroups(dispatch.workgroupsX);
            }
            pass.end();
        },
        destroy(): void {
            dispatches.length = 0;
            count = 0;
            _dispatchBatches?.delete(signature);
        },
        queue(dispatch): void {
            dispatches[count++] = dispatch;
        },
    };
    _dispatchBatches.set(signature, batch);
    return batch;
}

/** Create per-binding culling state. */
export function createTiCullState(): ThinInstanceGpuCullState {
    // CPU scratch is sized for the larger two-bucket variant; single-bucket states
    // only ever upload the first PARAM_BYTES of it.
    const paramsBytes = new ArrayBuffer(LOD_PARAM_BYTES);
    return {
        _capacity: 0,
        _visibleMatrixBuffer: null,
        _visibleColorBuffer: null,
        _argsBuffer: null,
        _paramsBuffer: null,
        _bindGroup: null,
        _srcMatrixBuffer: null,
        _srcColorBuffer: null,
        _hasColor: false,
        _localSphereReady: false,
        _localSphere: new F32(4),
        _paramsBytes: paramsBytes,
        _paramsF32: new F32(paramsBytes),
        _paramsU32: new U32(paramsBytes),
        _argsData: new U32(5),
        _drawBuffers: null,
        _indexCount: -1,
        _active: false,
        _lodActive: false,
        _lodMatrixBuffer: null,
        _lodColorBuffer: null,
        _lodArgsBuffer: null,
        _lodIndexCount: -1,
        _lodArgsZeroed: false,
    };
}

/** Destroy GPU resources owned by a per-binding cull state. */
export function destroyTiCullState(state: ThinInstanceGpuCullState): void {
    state._visibleMatrixBuffer?.destroy();
    state._visibleColorBuffer?.destroy();
    state._argsBuffer?.destroy();
    state._paramsBuffer?.destroy();
    state._lodMatrixBuffer?.destroy();
    state._lodColorBuffer?.destroy();
    state._lodArgsBuffer?.destroy();
    state._visibleMatrixBuffer = null;
    state._visibleColorBuffer = null;
    state._argsBuffer = null;
    state._paramsBuffer = null;
    state._lodMatrixBuffer = null;
    state._lodColorBuffer = null;
    state._lodArgsBuffer = null;
    state._bindGroup = null;
    state._drawBuffers = null;
}

/** Run culling for one render binding and return buffers for the subsequent indirect draw. */
export function prepareTiCull(
    engine: EngineContext,
    state: ThinInstanceGpuCullState,
    mesh: Mesh,
    gpu: MeshGPU,
    ti: ThinInstanceData,
    hasColor: boolean,
    context: DrawUpdateContext,
    dispatchBatch?: ComputeDispatchBatch,
    lodMesh?: Mesh | null
): ThinInstanceGpuCullResult | null {
    const camera = context._camera;
    if (!ti._gpuCullingEnabled || !camera || mesh.visible === false || ti.count === 0) {
        return cullFallback(engine, state);
    }
    if (hasColor && !ti.colors) {
        return cullFallback(engine, state);
    }
    const positions = mesh._cpuPositions;
    if (!state._localSphereReady || state._localPositions !== positions || state._localBoundMin !== mesh.boundMin || state._localBoundMax !== mesh.boundMax) {
        if (!computeLocalSphere(mesh as Mesh, state._localSphere)) {
            return cullFallback(engine, state);
        }
        state._localSphereReady = true;
        state._localPositions = positions;
        state._localBoundMin = mesh.boundMin;
        state._localBoundMax = mesh.boundMax;
    }

    syncThinInstanceGpuData(engine, ti, hasColor);
    const sourceMatrixBuffer = ti._gpuBuffer;
    const sourceColorBuffer = hasColor ? ti._colorGpuBuffer : null;
    if (!sourceMatrixBuffer || (hasColor && !sourceColorBuffer)) {
        return cullFallback(engine, state);
    }

    const lod = lodMesh ?? null;
    ensureCullBuffers(engine, state, ti._capacity, hasColor, lod !== null);
    const visibleMatrixBuffer = state._visibleMatrixBuffer!;
    const visibleColorBuffer = hasColor ? state._visibleColorBuffer! : null;
    const argsBuffer = state._argsBuffer!;
    const paramsBuffer = state._paramsBuffer!;
    const pipeline = getCullPipeline(engine, hasColor, lod !== null);

    if (state._bindGroup === null || state._srcMatrixBuffer !== sourceMatrixBuffer || state._srcColorBuffer !== sourceColorBuffer || state._hasColor !== hasColor) {
        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: { buffer: sourceMatrixBuffer } },
            { binding: 1, resource: { buffer: visibleMatrixBuffer } },
            { binding: 2, resource: { buffer: argsBuffer } },
            { binding: 3, resource: { buffer: paramsBuffer } },
        ];
        if (hasColor) {
            entries.push({ binding: 4, resource: { buffer: sourceColorBuffer! } }, { binding: 5, resource: { buffer: visibleColorBuffer! } });
        }
        if (lod) {
            entries.push({ binding: 6, resource: { buffer: state._lodMatrixBuffer! } }, { binding: 7, resource: { buffer: state._lodArgsBuffer! } });
            if (hasColor) {
                entries.push({ binding: 8, resource: { buffer: state._lodColorBuffer! } });
            }
        }
        state._bindGroup = engine._device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
        state._srcMatrixBuffer = sourceMatrixBuffer;
        state._srcColorBuffer = sourceColorBuffer;
        state._hasColor = hasColor;
    }

    const v = camera.viewport;
    const aspect = (context.targetWidth / context.targetHeight) * (v ? v.width / v.height : 1);
    writeCullParams(engine, state, mesh, gpu.indexCount, ti.count, camera, aspect, lod);

    const dispatch = {
        pipeline,
        bindGroup: state._bindGroup,
        workgroupsX: Math.ceil(ti.count / WORKGROUP_SIZE),
    };
    if (dispatchBatch) {
        dispatchBatch.queue(dispatch);
    } else {
        const pass = engine._currentEncoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, state._bindGroup);
        pass.dispatchWorkgroups(dispatch.workgroupsX);
        pass.end();
    }

    state._drawBuffers = { matrixBuffer: visibleMatrixBuffer, colorBuffer: visibleColorBuffer };
    setCullActive(state, true);
    if (lod) {
        return {
            drawBuffers: state._drawBuffers,
            argsBuffer,
            lodDrawBuffers: { matrixBuffer: state._lodMatrixBuffer!, colorBuffer: hasColor ? state._lodColorBuffer : null },
            lodArgsBuffer: state._lodArgsBuffer!,
        };
    }
    return { drawBuffers: state._drawBuffers, argsBuffer };
}

/** Shared early-out: deactivate culling for this pass. When the mesh has (or had) a LOD partner, the
 *  partner's far-bucket args are zeroed so even a stale recorded indirect draw renders zero instances —
 *  the full mesh's non-culled fallback then draws ALL instances without ever double-drawing the far set. */
function cullFallback(engine: EngineContext, state: ThinInstanceGpuCullState): null {
    if (state._lodArgsBuffer && !state._lodArgsZeroed) {
        engine._currentEncoder.clearBuffer(state._lodArgsBuffer, 4, 4);
        state._lodArgsZeroed = true;
    }
    setCullActive(state, false);
    state._drawBuffers = null;
    return null;
}

/** @internal Publish (or withdraw) one pass's far-bucket outputs for the LOD partner's binding. */
export function publishTiLodBucket(ti: ThinInstanceData, signature: RenderTargetSignature, result: ThinInstanceGpuCullResult | null): void {
    const lodDrawBuffers = result?.lodDrawBuffers;
    const lodArgsBuffer = result?.lodArgsBuffer;
    const buckets = ti._lodBuckets;
    if (lodDrawBuffers && lodArgsBuffer && buckets) {
        let bucket = buckets.get(signature);
        if (!bucket) {
            bucket = { matrixBuffer: lodDrawBuffers.matrixBuffer, colorBuffer: lodDrawBuffers.colorBuffer, argsBuffer: lodArgsBuffer, active: true };
            buckets.set(signature, bucket);
            return;
        }
        bucket.matrixBuffer = lodDrawBuffers.matrixBuffer;
        bucket.colorBuffer = lodDrawBuffers.colorBuffer;
        bucket.argsBuffer = lodArgsBuffer;
        bucket.active = true;
        return;
    }
    const bucket = ti._lodBuckets?.get(signature);
    if (bucket) {
        bucket.active = false;
    }
}

function ensureCullBuffers(engine: EngineContext, state: ThinInstanceGpuCullState, capacity: number, hasColor: boolean, lod: boolean): void {
    const device = engine._device;
    if (state._lodActive !== lod) {
        // The params uniform size and bind-group layout differ between the single-bucket and
        // two-bucket pipeline variants — rebuild both on a pairing transition.
        state._paramsBuffer?.destroy();
        state._paramsBuffer = null;
        state._bindGroup = null;
        if (!lod) {
            const lodMat = state._lodMatrixBuffer;
            const lodCol = state._lodColorBuffer;
            const lodArgs = state._lodArgsBuffer;
            if (lodArgs && !state._lodArgsZeroed) {
                // A stale partner bundle may still reference these args this frame — make it draw zero instances.
                engine._currentEncoder.clearBuffer(lodArgs, 4, 4);
            }
            if (lodMat || lodArgs) {
                // Retire (not destroy): the partner's binding may hold last frame's handles until it re-records.
                retireGpuResources(engine, () => {
                    lodMat?.destroy();
                    lodCol?.destroy();
                    lodArgs?.destroy();
                });
            }
            state._lodMatrixBuffer = null;
            state._lodColorBuffer = null;
            state._lodArgsBuffer = null;
            state._lodIndexCount = -1;
            state._lodArgsZeroed = false;
        }
        state._lodActive = lod;
        bumpVisibilityEpoch();
    }
    if (state._capacity < capacity) {
        state._visibleMatrixBuffer?.destroy();
        state._visibleColorBuffer?.destroy();
        state._visibleMatrixBuffer = device.createBuffer({
            size: Math.max(capacity * 64, 4),
            usage: BU.VERTEX | BU.STORAGE,
        });
        state._visibleColorBuffer = hasColor
            ? device.createBuffer({
                  size: Math.max(capacity * 16, 4),
                  usage: BU.VERTEX | BU.STORAGE,
              })
            : null;
        state._capacity = capacity;
        state._bindGroup = null;
        state._drawBuffers = null;
        bumpVisibilityEpoch();
    } else if (hasColor && !state._visibleColorBuffer) {
        state._visibleColorBuffer = device.createBuffer({
            size: Math.max(state._capacity * 16, 4),
            usage: BU.VERTEX | BU.STORAGE,
        });
        state._bindGroup = null;
        state._drawBuffers = null;
        bumpVisibilityEpoch();
    }
    if (lod && (!state._lodMatrixBuffer || state._lodMatrixBuffer.size < state._capacity * 64 || (hasColor && !state._lodColorBuffer))) {
        const oldMat = state._lodMatrixBuffer;
        const oldCol = state._lodColorBuffer;
        if (oldMat) {
            // Retire (not destroy): the partner's binding may hold last frame's handles until it re-records.
            retireGpuResources(engine, () => {
                oldMat.destroy();
                oldCol?.destroy();
            });
        }
        state._lodMatrixBuffer = device.createBuffer({
            size: Math.max(state._capacity * 64, 4),
            usage: BU.VERTEX | BU.STORAGE,
        });
        state._lodColorBuffer = hasColor
            ? device.createBuffer({
                  size: Math.max(state._capacity * 16, 4),
                  usage: BU.VERTEX | BU.STORAGE,
              })
            : null;
        state._bindGroup = null;
        bumpVisibilityEpoch();
    }
    if (lod && !state._lodArgsBuffer) {
        state._lodArgsBuffer = device.createBuffer({
            size: INDIRECT_ARGS_BYTES,
            usage: BU.INDIRECT | BU.STORAGE | BU.COPY_DST,
        });
        state._lodIndexCount = -1;
        state._lodArgsZeroed = false;
    }
    if (!state._argsBuffer) {
        state._argsBuffer = device.createBuffer({
            size: INDIRECT_ARGS_BYTES,
            usage: BU.INDIRECT | BU.STORAGE | BU.COPY_DST,
        });
    }
    if (!state._paramsBuffer) {
        state._paramsBuffer = device.createBuffer({
            size: lod ? LOD_PARAM_BYTES : PARAM_BYTES,
            usage: BU.UNIFORM | BU.COPY_DST,
        });
    }
}

function getCullPipeline(engine: EngineContext, hasColor: boolean, lod: boolean): GPUComputePipeline {
    const device = engine._device;
    if (_cachedDevice !== device) {
        _cachedDevice = device;
        _pipelineNoColor = null;
        _pipelineColor = null;
        _pipelineLodNoColor = null;
        _pipelineLodColor = null;
    }
    if (lod) {
        if (hasColor) {
            _pipelineLodColor ??= device.createComputePipeline({
                layout: "auto",
                compute: { module: device.createShaderModule({ code: CULL_WGSL_LOD_COLOR }), entryPoint: "mainLodColor" },
            });
            return _pipelineLodColor;
        }
        _pipelineLodNoColor ??= device.createComputePipeline({
            layout: "auto",
            compute: { module: device.createShaderModule({ code: CULL_WGSL_LOD_NO_COLOR }), entryPoint: "mainLod" },
        });
        return _pipelineLodNoColor;
    }
    if (hasColor) {
        _pipelineColor ??= device.createComputePipeline({
            layout: "auto",
            compute: { module: device.createShaderModule({ code: CULL_WGSL_COLOR }), entryPoint: "mainColor" },
        });
        return _pipelineColor;
    }
    _pipelineNoColor ??= device.createComputePipeline({
        layout: "auto",
        compute: { module: device.createShaderModule({ code: CULL_WGSL_NO_COLOR }), entryPoint: "main" },
    });
    return _pipelineNoColor;
}

function writeCullParams(
    engine: EngineContext,
    state: ThinInstanceGpuCullState,
    mesh: Mesh,
    indexCount: number,
    instanceCount: number,
    camera: Camera,
    aspect: number,
    lodMesh: Mesh | null
): void {
    const params = state._paramsF32;
    const viewProjection = getViewProjectionMatrix(camera, aspect);
    writeFrustumPlanes(params, viewProjection);
    params.set(mesh.worldMatrix, MESH_WORLD_FLOAT_OFFSET);
    params.set(state._localSphere, LOCAL_SPHERE_FLOAT_OFFSET);
    state._paramsU32[COUNT_U32_OFFSET] = instanceCount;
    params[BOUNDS_PAD_F32_OFFSET] = mesh.thinInstances?._cullBoundsPad ?? 0;
    if (lodMesh) {
        // Distance test uses the culling pass's own camera (same one the frustum planes come from).
        const cw = camera.worldMatrix;
        params[CAM_POS_DIST_F32_OFFSET] = cw[12]!;
        params[CAM_POS_DIST_F32_OFFSET + 1] = cw[13]!;
        params[CAM_POS_DIST_F32_OFFSET + 2] = cw[14]!;
        params[CAM_POS_DIST_F32_OFFSET + 3] = mesh.thinInstances?._lodDistance ?? 0;
        params[LOD_BAND_F32_OFFSET] = mesh.thinInstances?._lodBand ?? 0;
    }

    if (state._indexCount !== indexCount) {
        const args = state._argsData;
        args[0] = indexCount;
        args[1] = 0;
        args[2] = 0;
        args[3] = 0;
        args[4] = 0;
        engine._device.queue.writeBuffer(state._argsBuffer!, 0, args.buffer, args.byteOffset, args.byteLength);
        state._indexCount = indexCount;
    } else {
        engine._currentEncoder.clearBuffer(state._argsBuffer!, 4, 4);
    }
    if (lodMesh) {
        // Far-bucket args carry the PARTNER mesh's index count; the compute pass fills its instance count.
        const lodGpu = lodMesh._gpu as MeshGPU | undefined;
        const lodIndexCount = lodGpu ? lodGpu.indexCount : 0;
        if (state._lodIndexCount !== lodIndexCount) {
            const args = state._argsData;
            args[0] = lodIndexCount;
            args[1] = 0;
            args[2] = 0;
            args[3] = 0;
            args[4] = 0;
            engine._device.queue.writeBuffer(state._lodArgsBuffer!, 0, args.buffer, args.byteOffset, args.byteLength);
            state._lodIndexCount = lodIndexCount;
        } else {
            engine._currentEncoder.clearBuffer(state._lodArgsBuffer!, 4, 4);
        }
        state._lodArgsZeroed = false;
    }
    engine._device.queue.writeBuffer(state._paramsBuffer!, 0, state._paramsBytes, 0, lodMesh ? LOD_PARAM_BYTES : PARAM_BYTES);
}

function setCullActive(state: ThinInstanceGpuCullState, active: boolean): void {
    if (state._active !== active) {
        state._active = active;
        bumpVisibilityEpoch();
    }
}

function writeFrustumPlanes(out: Float32Array, m: Mat4): void {
    writePlane(out, 0, m[3]! + m[0]!, m[7]! + m[4]!, m[11]! + m[8]!, m[15]! + m[12]!);
    writePlane(out, 4, m[3]! - m[0]!, m[7]! - m[4]!, m[11]! - m[8]!, m[15]! - m[12]!);
    writePlane(out, 8, m[3]! + m[1]!, m[7]! + m[5]!, m[11]! + m[9]!, m[15]! + m[13]!);
    writePlane(out, 12, m[3]! - m[1]!, m[7]! - m[5]!, m[11]! - m[9]!, m[15]! - m[13]!);
    writePlane(out, 16, m[2]!, m[6]!, m[10]!, m[14]!);
    writePlane(out, 20, m[3]! - m[2]!, m[7]! - m[6]!, m[11]! - m[10]!, m[15]! - m[14]!);
}

function writePlane(out: Float32Array, offset: number, x: number, y: number, z: number, w: number): void {
    const invLen = 1 / Math.hypot(x, y, z);
    out[offset] = x * invLen;
    out[offset + 1] = y * invLen;
    out[offset + 2] = z * invLen;
    out[offset + 3] = w * invLen;
}

function computeLocalSphere(mesh: Mesh, out: Float32Array): boolean {
    const positions = mesh._cpuPositions;
    if (!positions || positions.length < 3) {
        return false;
    }
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i]!;
        const y = positions[i + 1]!;
        const z = positions[i + 2]!;
        if (x < minX) {
            minX = x;
        }
        if (x > maxX) {
            maxX = x;
        }
        if (y < minY) {
            minY = y;
        }
        if (y > maxY) {
            maxY = y;
        }
        if (z < minZ) {
            minZ = z;
        }
        if (z > maxZ) {
            maxZ = z;
        }
    }
    if (!isFinite(minX)) {
        return false;
    }
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const dx = maxX - cx;
    const dy = maxY - cy;
    const dz = maxZ - cz;
    out[0] = cx;
    out[1] = cy;
    out[2] = cz;
    out[3] = Math.hypot(dx, dy, dz);
    return true;
}
