import type { EngineContextInternal } from "../engine/engine.js";
import type { Mat4 } from "../math/types.js";
import { SCENE_UBO_WGSL } from "../shader/scene-uniforms.js";
import type { BillboardBlendMode, BillboardDepthMode, BillboardOrientation, BillboardSpriteSystem } from "./billboard-sprite.js";
import { BILLBOARD_INSTANCE_FLOATS_PER_SPRITE, BILLBOARD_INSTANCE_STRIDE_BYTES } from "./billboard-sprite.js";

export interface BillboardPipelineDeviceCache {
    _shaderModules: Map<string, GPUShaderModule>;
    _pipelines: Map<string, GPURenderPipeline>;
}

export interface BillboardPipelineCache {
    _devices: WeakMap<GPUDevice, BillboardPipelineDeviceCache>;
}

const BLEND_MODE_TABLE: Readonly<Record<BillboardBlendMode, { index: number; descriptor?: GPUBlendState }>> = {
    alpha: {
        index: 0,
        descriptor: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
    },
    premultiplied: {
        index: 1,
        descriptor: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
    },
    cutout: {
        index: 2,
    },
};

const DEPTH_MODE_TABLE: Readonly<Record<BillboardDepthMode, { index: number; writeEnabled: boolean }>> = {
    transparent: { index: 0, writeEnabled: false },
    cutout: { index: 1, writeEnabled: true },
};

const BILLBOARD_POSITION_OFFSET_BYTES = 0;
const BILLBOARD_SIZE_OFFSET_BYTES = 12;
const BILLBOARD_UV_MIN_OFFSET_BYTES = 20;
const BILLBOARD_UV_MAX_OFFSET_BYTES = 28;
const BILLBOARD_ROTATION_OFFSET_BYTES = 36;
const BILLBOARD_PIVOT_OFFSET_BYTES = 40;
const BILLBOARD_COLOR_OFFSET_BYTES = 48;

export const BILLBOARD_SYSTEM_UBO_BYTES = 32;
const BILLBOARD_SYSTEM_UBO_FLOATS = BILLBOARD_SYSTEM_UBO_BYTES / 4;
export const BILLBOARD_INDEX_DATA: Readonly<Uint16Array> = new Uint16Array([0, 1, 2, 0, 2, 3]);

export interface BillboardInstanceSortScratch {
    _capacity: number;
    _sortedInstanceData: Float32Array;
    _sortIndices: Uint32Array;
    _sortDepths: Float32Array;
}

function getBlendModeEntry(blendMode: BillboardBlendMode): (typeof BLEND_MODE_TABLE)[BillboardBlendMode] {
    return BLEND_MODE_TABLE[blendMode];
}

function getDepthModeEntry(depthMode: BillboardDepthMode): (typeof DEPTH_MODE_TABLE)[BillboardDepthMode] {
    return DEPTH_MODE_TABLE[depthMode];
}

function makeBillboardBasisWgsl(orientation: BillboardOrientation): string {
    switch (orientation) {
        case "facing":
            return `struct BillboardBasis {
right: vec3<f32>,
up: vec3<f32>,
};
fn getBillboardBasis(_anchor: vec3<f32>) -> BillboardBasis {
let cameraRight = normalize(vec3<f32>(scene.view[0][0], scene.view[1][0], scene.view[2][0]));
let cameraUp = normalize(vec3<f32>(scene.view[0][1], scene.view[1][1], scene.view[2][1]));
return BillboardBasis(cameraRight, -cameraUp);
}`;
        case "axis-locked":
            return `struct BillboardBasis {
right: vec3<f32>,
up: vec3<f32>,
};
fn getBillboardBasis(_anchor: vec3<f32>) -> BillboardBasis {
let lockAxis = normalize(billboards.axisAndCutoff.xyz);
let cameraRight = normalize(vec3<f32>(scene.view[0][0], scene.view[1][0], scene.view[2][0]));
let projectedRight = cameraRight - lockAxis * dot(cameraRight, lockAxis);
let projectedRightLen = length(projectedRight);
let safeProjectedRightLen = max(projectedRightLen, 1e-4);
let fallbackSeed = select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), abs(lockAxis.z) > 0.999);
let fallbackRightRaw = cross(lockAxis, fallbackSeed);
let fallbackRight = fallbackRightRaw / max(length(fallbackRightRaw), 1e-4);
let right = select(fallbackRight, projectedRight / safeProjectedRightLen, projectedRightLen > 1e-4);
return BillboardBasis(right, -lockAxis);
}`;
    }
}

function makeBillboardFragmentWgsl(depthMode: BillboardDepthMode): string {
    if (depthMode === "cutout") {
        return `@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
let sampleColor = textureSample(atlasTex, atlasSamp, in.uv);
if (sampleColor.a < billboards.axisAndCutoff.w) {
discard;
}
return sampleColor * in.tint * billboards.opacityMul;
}`;
    }
    return `@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
let sampleColor = textureSample(atlasTex, atlasSamp, in.uv);
return sampleColor * in.tint * billboards.opacityMul;
}`;
}

function makeBillboardWgsl(orientation: BillboardOrientation, depthMode: BillboardDepthMode): string {
    return `${SCENE_UBO_WGSL}
struct BillboardSystem {
opacityMul: vec4<f32>,
axisAndCutoff: vec4<f32>,
};
@group(1) @binding(0) var<uniform> billboards: BillboardSystem;
@group(1) @binding(1) var atlasTex: texture_2d<f32>;
@group(1) @binding(2) var atlasSamp: sampler;
${makeBillboardBasisWgsl(orientation)}
struct VIn {
@builtin(vertex_index) vid: u32,
@location(0) iPos: vec3<f32>,
@location(1) iSize: vec2<f32>,
@location(2) iUvMin: vec2<f32>,
@location(3) iUvMax: vec2<f32>,
@location(4) iRot: f32,
@location(5) iPivot: vec2<f32>,
@location(6) iColor: vec4<f32>,
};
struct VOut {
@builtin(position) pos: vec4<f32>,
@location(0) uv: vec2<f32>,
@location(1) tint: vec4<f32>,
};
@vertex
fn vs(in: VIn) -> VOut {
let corner = vec2<f32>(select(0.0, 1.0, in.vid == 1u || in.vid == 2u), select(0.0, 1.0, in.vid >= 2u));
let local = (corner - in.iPivot) * in.iSize;
let cosRot = cos(in.iRot);
let sinRot = sin(in.iRot);
let rotated = vec2<f32>(local.x * cosRot - local.y * sinRot, local.x * sinRot + local.y * cosRot);
let basis = getBillboardBasis(in.iPos);
let worldPos = in.iPos + basis.right * rotated.x + basis.up * rotated.y;
var out: VOut;
out.pos = scene.viewProjection * vec4<f32>(worldPos, 1.0);
out.uv = mix(in.iUvMin, in.iUvMax, corner);
out.tint = in.iColor;
return out;
}
${makeBillboardFragmentWgsl(depthMode)}`;
}

export function createBillboardPipelineCache(): BillboardPipelineCache {
    return {
        _devices: new WeakMap(),
    };
}

export function resetBillboardPipelineCache(cache: BillboardPipelineCache): void {
    cache._devices = new WeakMap();
}

export function getOrCreateBillboardPipeline(
    engine: EngineContextInternal,
    cache: BillboardPipelineCache,
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    system: BillboardSpriteSystem,
    depthStencilFormat: GPUTextureFormat,
    sceneBindGroupLayout: GPUBindGroupLayout
): GPURenderPipeline {
    const deviceCache = getBillboardPipelineDeviceCache(engine, cache);
    const blendEntry = getBlendModeEntry(system.blendMode);
    const depthEntry = getDepthModeEntry(system._depthMode);
    const key = `${format}:${sampleCount}:${system._orientation}:${blendEntry.index}:${depthEntry.index}:${depthStencilFormat}`;
    const cached = deviceCache._pipelines.get(key);
    if (cached) {
        return cached;
    }
    const pipeline = buildBillboardPipeline(engine, deviceCache, format, sampleCount, system, depthStencilFormat, sceneBindGroupLayout);
    deviceCache._pipelines.set(key, pipeline);
    return pipeline;
}

export function createBillboardInstanceBuffer(device: GPUDevice, system: BillboardSpriteSystem, label?: string): GPUBuffer {
    return device.createBuffer({
        label,
        size: system._capacity * BILLBOARD_INSTANCE_STRIDE_BYTES,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
}

export function createBillboardInstanceSortScratch(): BillboardInstanceSortScratch {
    return {
        _capacity: 0,
        _sortedInstanceData: new Float32Array(0),
        _sortIndices: new Uint32Array(0),
        _sortDepths: new Float32Array(0),
    };
}

export function uploadSortedBillboardInstances(
    device: GPUDevice,
    system: BillboardSpriteSystem,
    instanceBuffer: GPUBuffer,
    scratch: BillboardInstanceSortScratch,
    cameraViewMatrix: Mat4
): void {
    const count = system.count;
    if (count === 0) {
        system._dirtyMin = 0;
        system._dirtyMax = 0;
        return;
    }
    ensureBillboardInstanceSortScratch(scratch, count);
    const sourceData = system._instanceData;
    const sortedData = scratch._sortedInstanceData;
    const indices = scratch._sortIndices;
    const depths = scratch._sortDepths;
    for (let index = 0; index < count; index++) {
        const base = index * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE;
        const anchorX = sourceData[base]!;
        const anchorY = sourceData[base + 1]!;
        const anchorZ = sourceData[base + 2]!;
        indices[index] = index;
        depths[index] = cameraViewMatrix[2]! * anchorX + cameraViewMatrix[6]! * anchorY + cameraViewMatrix[10]! * anchorZ + cameraViewMatrix[14]!;
    }
    indices.subarray(0, count).sort((left, right) => depths[right]! - depths[left]! || left - right);
    for (let outIndex = 0; outIndex < count; outIndex++) {
        const sourceBase = indices[outIndex]! * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE;
        const destBase = outIndex * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE;
        for (let field = 0; field < BILLBOARD_INSTANCE_FLOATS_PER_SPRITE; field++) {
            sortedData[destBase + field] = sourceData[sourceBase + field]!;
        }
    }
    device.queue.writeBuffer(instanceBuffer, 0, sortedData.buffer, sortedData.byteOffset, count * BILLBOARD_INSTANCE_STRIDE_BYTES);
    system._dirtyMin = 0;
    system._dirtyMax = 0;
}

export function ensureBillboardInstanceBuffer(
    device: GPUDevice,
    system: BillboardSpriteSystem,
    currentBuffer: GPUBuffer,
    currentCapacity: number,
    label?: string
): { buffer: GPUBuffer; capacity: number; reallocated: boolean } {
    if (currentCapacity >= system._capacity) {
        return { buffer: currentBuffer, capacity: currentCapacity, reallocated: false };
    }
    currentBuffer.destroy();
    return { buffer: createBillboardInstanceBuffer(device, system, label), capacity: system._capacity, reallocated: true };
}

export function uploadBillboardInstances(device: GPUDevice, system: BillboardSpriteSystem, instanceBuffer: GPUBuffer, uploadedVersion: number): number {
    if (uploadedVersion === system._version) {
        return uploadedVersion;
    }
    if (system.count === 0) {
        system._dirtyMin = 0;
        system._dirtyMax = 0;
        return system._version;
    }
    let lowIndex: number;
    let highIndex: number;
    if (uploadedVersion === -1) {
        lowIndex = 0;
        highIndex = system.count;
    } else {
        lowIndex = system._dirtyMin;
        highIndex = Math.min(system._dirtyMax, system.count);
    }
    if (highIndex > lowIndex) {
        const offsetBytes = lowIndex * BILLBOARD_INSTANCE_STRIDE_BYTES;
        const byteLength = (highIndex - lowIndex) * BILLBOARD_INSTANCE_STRIDE_BYTES;
        device.queue.writeBuffer(instanceBuffer, offsetBytes, system._instanceData.buffer, system._instanceData.byteOffset + offsetBytes, byteLength);
    }
    system._dirtyMin = 0;
    system._dirtyMax = 0;
    return system._version;
}

function ensureBillboardInstanceSortScratch(scratch: BillboardInstanceSortScratch, count: number): void {
    if (scratch._capacity >= count) {
        return;
    }
    scratch._capacity = count;
    scratch._sortedInstanceData = new Float32Array(count * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE);
    scratch._sortIndices = new Uint32Array(count);
    scratch._sortDepths = new Float32Array(count);
}

export function buildBillboardSystemUbo(system: BillboardSpriteSystem, ubo: Float32Array): void {
    const opacity = system.opacity;
    if (system.blendMode === "premultiplied") {
        ubo[0] = opacity;
        ubo[1] = opacity;
        ubo[2] = opacity;
        ubo[3] = opacity;
    } else {
        ubo[0] = 1;
        ubo[1] = 1;
        ubo[2] = 1;
        ubo[3] = opacity;
    }
    ubo[4] = system._axis[0];
    ubo[5] = system._axis[1];
    ubo[6] = system._axis[2];
    ubo[7] = system.alphaCutoff;
}

export function writeBillboardSystemUboIfDirty(device: GPUDevice, uniformBuffer: GPUBuffer, scratchUbo: Float32Array, lastUbo: Float32Array, forceWrite: boolean): void {
    let dirty = forceWrite;
    if (!dirty) {
        for (let index = 0; index < BILLBOARD_SYSTEM_UBO_FLOATS; index++) {
            if (lastUbo[index] !== scratchUbo[index]) {
                dirty = true;
                break;
            }
        }
    }
    if (dirty) {
        device.queue.writeBuffer(uniformBuffer, 0, scratchUbo.buffer, scratchUbo.byteOffset, BILLBOARD_SYSTEM_UBO_BYTES);
        lastUbo.set(scratchUbo);
    }
}

export function createBillboardSystemBindGroup(engine: EngineContextInternal, pipeline: GPURenderPipeline, system: BillboardSpriteSystem, uniformBuffer: GPUBuffer): GPUBindGroup {
    const texture = system.atlas.texture;
    return engine.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: texture.view },
            { binding: 2, resource: texture.sampler },
        ],
    });
}

function getBillboardPipelineDeviceCache(engine: EngineContextInternal, cache: BillboardPipelineCache): BillboardPipelineDeviceCache {
    let deviceCache = cache._devices.get(engine.device);
    if (!deviceCache) {
        deviceCache = { _shaderModules: new Map(), _pipelines: new Map() };
        cache._devices.set(engine.device, deviceCache);
    }
    return deviceCache;
}

function getShaderModule(engine: EngineContextInternal, cache: BillboardPipelineDeviceCache, orientation: BillboardOrientation, depthMode: BillboardDepthMode): GPUShaderModule {
    const key = `${orientation}:${getDepthModeEntry(depthMode).index}`;
    let module = cache._shaderModules.get(key);
    if (!module) {
        module = engine.device.createShaderModule({ code: makeBillboardWgsl(orientation, depthMode) });
        cache._shaderModules.set(key, module);
    }
    return module;
}

function buildBillboardPipeline(
    engine: EngineContextInternal,
    cache: BillboardPipelineDeviceCache,
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    system: BillboardSpriteSystem,
    depthStencilFormat: GPUTextureFormat,
    sceneBindGroupLayout: GPUBindGroupLayout
): GPURenderPipeline {
    const device = engine.device;
    const blendEntry = getBlendModeEntry(system.blendMode);
    const depthEntry = getDepthModeEntry(system._depthMode);
    const shaderModule = getShaderModule(engine, cache, system._orientation, system._depthMode);
    const billboardBindGroupLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        ],
    });
    return device.createRenderPipeline({
        label: `${system._orientation}-billboard-sprite-pipeline`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBindGroupLayout, billboardBindGroupLayout] }),
        vertex: {
            module: shaderModule,
            entryPoint: "vs",
            buffers: [
                {
                    arrayStride: BILLBOARD_INSTANCE_STRIDE_BYTES,
                    stepMode: "instance",
                    attributes: [
                        { shaderLocation: 0, offset: BILLBOARD_POSITION_OFFSET_BYTES, format: "float32x3" },
                        { shaderLocation: 1, offset: BILLBOARD_SIZE_OFFSET_BYTES, format: "float32x2" },
                        { shaderLocation: 2, offset: BILLBOARD_UV_MIN_OFFSET_BYTES, format: "float32x2" },
                        { shaderLocation: 3, offset: BILLBOARD_UV_MAX_OFFSET_BYTES, format: "float32x2" },
                        { shaderLocation: 4, offset: BILLBOARD_ROTATION_OFFSET_BYTES, format: "float32" },
                        { shaderLocation: 5, offset: BILLBOARD_PIVOT_OFFSET_BYTES, format: "float32x2" },
                        { shaderLocation: 6, offset: BILLBOARD_COLOR_OFFSET_BYTES, format: "float32x4" },
                    ],
                },
            ],
        },
        fragment: {
            module: shaderModule,
            entryPoint: "fs",
            targets: [blendEntry.descriptor ? { format, blend: blendEntry.descriptor, writeMask: GPUColorWrite.ALL } : { format, writeMask: GPUColorWrite.ALL }],
        },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: depthStencilFormat, depthCompare: "greater-equal", depthWriteEnabled: depthEntry.writeEnabled },
        multisample: { count: sampleCount },
    });
}
