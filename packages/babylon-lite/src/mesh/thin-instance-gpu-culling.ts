/** GPU frustum culling for opt-in thin instances.
 *
 * Dynamically imported only when a scene enables thin-instance GPU culling.
 * Each render binding owns its own state so render tasks with different cameras
 * never clobber one another's compacted instance buffers or indirect args.
 */

import type { Camera } from "../camera/camera.js";
import { getViewProjectionMatrix } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { DrawUpdateContext } from "../render/renderable.js";
import type { Mat4 } from "../math/types.js";
import type { Mesh, MeshGPU } from "./mesh.js";
import type { ThinInstanceData } from "./thin-instance.js";
import { syncThinInstanceGpuData } from "./thin-instance-gpu.js";
import type { ThinInstanceDrawBuffers } from "./thin-instance-gpu.js";

const WORKGROUP_SIZE = 64;
const PARAM_BYTES = 192;
const COUNT_U32_OFFSET = 44;
const MESH_WORLD_FLOAT_OFFSET = 24;
const LOCAL_SPHERE_FLOAT_OFFSET = 40;
const INDIRECT_ARGS_BYTES = 20;

const CULL_WGSL_NO_COLOR = /* wgsl */ `
struct CullParams{planes:array<vec4<f32>,6>,meshWorld:mat4x4<f32>,localSphere:vec4<f32>,count:u32};
@group(0)@binding(0)var<storage,read> srcMatrices:array<mat4x4<f32>>;
@group(0)@binding(1)var<storage,read_write> dstMatrices:array<mat4x4<f32>>;
@group(0)@binding(2)var<storage,read_write> args:array<atomic<u32>>;
@group(0)@binding(3)var<uniform> params:CullParams;
fn visible(world:mat4x4<f32>)->bool{
let center=(world*vec4<f32>(params.localSphere.xyz,1.0)).xyz;
let sx=length(world[0].xyz);
let sy=length(world[1].xyz);
let sz=length(world[2].xyz);
let radius=params.localSphere.w*max(max(sx,sy),sz)+0.0001;
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
}

/** Result consumed by a material draw closure after culling has run for the active pass. */
export interface ThinInstanceGpuCullResult {
    readonly drawBuffers: ThinInstanceDrawBuffers;
    readonly argsBuffer: GPUBuffer;
}

let _cachedDevice: GPUDevice | null = null;
let _pipelineNoColor: GPUComputePipeline | null = null;
let _pipelineColor: GPUComputePipeline | null = null;

/** Create per-binding culling state. */
export function createTiCullState(): ThinInstanceGpuCullState {
    const paramsBytes = new ArrayBuffer(PARAM_BYTES);
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
        _localSphere: new Float32Array(4),
        _paramsBytes: paramsBytes,
        _paramsF32: new Float32Array(paramsBytes),
        _paramsU32: new Uint32Array(paramsBytes),
        _argsData: new Uint32Array(5),
        _drawBuffers: null,
    };
}

/** Destroy GPU resources owned by a per-binding cull state. */
export function destroyTiCullState(state: ThinInstanceGpuCullState): void {
    state._visibleMatrixBuffer?.destroy();
    state._visibleColorBuffer?.destroy();
    state._argsBuffer?.destroy();
    state._paramsBuffer?.destroy();
    state._visibleMatrixBuffer = null;
    state._visibleColorBuffer = null;
    state._argsBuffer = null;
    state._paramsBuffer = null;
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
    context: DrawUpdateContext
): ThinInstanceGpuCullResult | null {
    const camera = context._camera;
    if (!ti._gpuCullingEnabled || !camera || mesh.visible === false || ti.count === 0) {
        state._drawBuffers = null;
        return null;
    }
    if (hasColor && !ti.colors) {
        state._drawBuffers = null;
        return null;
    }
    if (!state._localSphereReady && !computeLocalSphere(mesh as Mesh, state._localSphere)) {
        state._drawBuffers = null;
        return null;
    }
    state._localSphereReady = true;

    syncThinInstanceGpuData(engine, ti, hasColor);
    const sourceMatrixBuffer = ti._gpuBuffer;
    const sourceColorBuffer = hasColor ? ti._colorGpuBuffer : null;
    if (!sourceMatrixBuffer || (hasColor && !sourceColorBuffer)) {
        state._drawBuffers = null;
        return null;
    }

    ensureCullBuffers(engine, state, ti._capacity, hasColor);
    const visibleMatrixBuffer = state._visibleMatrixBuffer!;
    const visibleColorBuffer = hasColor ? state._visibleColorBuffer! : null;
    const argsBuffer = state._argsBuffer!;
    const paramsBuffer = state._paramsBuffer!;
    const pipeline = getCullPipeline(engine, hasColor);

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
        state._bindGroup = engine._device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
        state._srcMatrixBuffer = sourceMatrixBuffer;
        state._srcColorBuffer = sourceColorBuffer;
        state._hasColor = hasColor;
    }

    const v = camera.viewport;
    const aspect = (context.targetWidth / context.targetHeight) * (v ? v.width / v.height : 1);
    writeCullParams(engine, state, mesh, gpu.indexCount, ti.count, camera, aspect);

    const pass = engine._currentEncoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, state._bindGroup);
    pass.dispatchWorkgroups(Math.ceil(ti.count / WORKGROUP_SIZE));
    pass.end();

    state._drawBuffers = { matrixBuffer: visibleMatrixBuffer, colorBuffer: visibleColorBuffer };
    return { drawBuffers: state._drawBuffers, argsBuffer };
}

function ensureCullBuffers(engine: EngineContext, state: ThinInstanceGpuCullState, capacity: number, hasColor: boolean): void {
    const device = engine._device;
    if (state._capacity < capacity) {
        state._visibleMatrixBuffer?.destroy();
        state._visibleColorBuffer?.destroy();
        state._visibleMatrixBuffer = device.createBuffer({
            size: Math.max(capacity * 64, 4),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE,
        });
        state._visibleColorBuffer = hasColor
            ? device.createBuffer({
                  size: Math.max(capacity * 16, 4),
                  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE,
              })
            : null;
        state._capacity = capacity;
        state._bindGroup = null;
        state._drawBuffers = null;
    } else if (hasColor && !state._visibleColorBuffer) {
        state._visibleColorBuffer = device.createBuffer({
            size: Math.max(state._capacity * 16, 4),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE,
        });
        state._bindGroup = null;
        state._drawBuffers = null;
    }
    if (!state._argsBuffer) {
        state._argsBuffer = device.createBuffer({
            size: INDIRECT_ARGS_BYTES,
            usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    }
    if (!state._paramsBuffer) {
        state._paramsBuffer = device.createBuffer({
            size: PARAM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }
}

function getCullPipeline(engine: EngineContext, hasColor: boolean): GPUComputePipeline {
    const device = engine._device;
    if (_cachedDevice !== device) {
        _cachedDevice = device;
        _pipelineNoColor = null;
        _pipelineColor = null;
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

function writeCullParams(engine: EngineContext, state: ThinInstanceGpuCullState, mesh: Mesh, indexCount: number, instanceCount: number, camera: Camera, aspect: number): void {
    const params = state._paramsF32;
    const viewProjection = getViewProjectionMatrix(camera, aspect);
    writeFrustumPlanes(params, viewProjection);
    params.set(mesh.worldMatrix, MESH_WORLD_FLOAT_OFFSET);
    params.set(state._localSphere, LOCAL_SPHERE_FLOAT_OFFSET);
    state._paramsU32[COUNT_U32_OFFSET] = instanceCount;

    const args = state._argsData;
    args[0] = indexCount;
    args[1] = 0;
    args[2] = 0;
    args[3] = 0;
    args[4] = 0;

    engine._device.queue.writeBuffer(state._argsBuffer!, 0, args.buffer, args.byteOffset, args.byteLength);
    engine._device.queue.writeBuffer(state._paramsBuffer!, 0, state._paramsBytes);
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
