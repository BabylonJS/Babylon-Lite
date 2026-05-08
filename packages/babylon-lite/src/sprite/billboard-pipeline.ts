import type { EngineContextInternal } from "../engine/engine.js";
import { SCENE_UBO_WGSL } from "../shader/scene-uniforms.js";
import type { SpriteBlendMode } from "./sprite-2d.js";
import type { BillboardSpriteSystem } from "./billboard-sprite.js";
import { BILLBOARD_INSTANCE_STRIDE_BYTES } from "./billboard-sprite.js";

export interface BillboardPipelineDeviceCache {
    _shaderModule: GPUShaderModule | null;
    _pipelines: Map<string, GPURenderPipeline>;
}

export interface BillboardPipelineCache {
    _devices: WeakMap<GPUDevice, BillboardPipelineDeviceCache>;
    _lastDeviceCache: BillboardPipelineDeviceCache | null;
}

type SupportedBillboardBlendMode = Extract<SpriteBlendMode, "alpha" | "premultiplied">;

const BLEND_MODE_TABLE: Readonly<Record<SupportedBillboardBlendMode, { index: number; descriptor: GPUBlendState }>> = {
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
};

export const BILLBOARD_SYSTEM_UBO_BYTES = 16;
const BILLBOARD_SYSTEM_UBO_FLOATS = BILLBOARD_SYSTEM_UBO_BYTES / 4;
export const BILLBOARD_INDEX_DATA: Readonly<Uint16Array> = new Uint16Array([0, 1, 2, 0, 2, 3]);

function getBlendModeEntry(blendMode: SpriteBlendMode): (typeof BLEND_MODE_TABLE)[SupportedBillboardBlendMode] {
    if (blendMode === "alpha" || blendMode === "premultiplied") {
        return BLEND_MODE_TABLE[blendMode];
    }
    throw new Error(`Billboard pipeline: blendMode: "${blendMode}" is not supported yet.`);
}

function makeFacingBillboardWgsl(): string {
    return `${SCENE_UBO_WGSL}
struct BillboardSystem {
opacityMul: vec4<f32>,
};
@group(1) @binding(0) var<uniform> billboards: BillboardSystem;
@group(1) @binding(1) var atlasTex: texture_2d<f32>;
@group(1) @binding(2) var atlasSamp: sampler;
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
var corners = array<vec2<f32>, 4>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0));
let corner = corners[in.vid];
let local = (corner - in.iPivot) * in.iSize;
let cosRot = cos(in.iRot);
let sinRot = sin(in.iRot);
let rotated = vec2<f32>(local.x * cosRot - local.y * sinRot, local.x * sinRot + local.y * cosRot);
let cameraRight = normalize(vec3<f32>(scene.view[0][0], scene.view[1][0], scene.view[2][0]));
let cameraUp = normalize(vec3<f32>(scene.view[0][1], scene.view[1][1], scene.view[2][1]));
let worldPos = in.iPos + cameraRight * rotated.x - cameraUp * rotated.y;
var out: VOut;
out.pos = scene.viewProjection * vec4<f32>(worldPos, 1.0);
out.uv = mix(in.iUvMin, in.iUvMax, corner);
out.tint = in.iColor;
return out;
}
@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
let sampleColor = textureSample(atlasTex, atlasSamp, in.uv);
return sampleColor * in.tint * billboards.opacityMul;
}`;
}

export function createBillboardPipelineCache(): BillboardPipelineCache {
    return {
        _devices: new WeakMap(),
        _lastDeviceCache: null,
    };
}

export function clearBillboardPipelineCache(cache: BillboardPipelineCache): void {
    cache._devices = new WeakMap();
    cache._lastDeviceCache = null;
}

export function getBillboardPipelineCacheSize(cache: BillboardPipelineCache): number {
    return cache._lastDeviceCache?._pipelines.size ?? 0;
}

export function getOrCreateFacingBillboardPipeline(
    engine: EngineContextInternal,
    cache: BillboardPipelineCache,
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    blendMode: SpriteBlendMode,
    depthStencilFormat: GPUTextureFormat,
    sceneBindGroupLayout: GPUBindGroupLayout
): GPURenderPipeline {
    const deviceCache = getBillboardPipelineDeviceCache(engine, cache);
    const key = `${format}:${sampleCount}:${getBlendModeEntry(blendMode).index}:${depthStencilFormat}`;
    const cached = deviceCache._pipelines.get(key);
    if (cached) {
        return cached;
    }
    const pipeline = buildFacingBillboardPipeline(engine, deviceCache, format, sampleCount, blendMode, depthStencilFormat, sceneBindGroupLayout);
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
    if (uploadedVersion === system._version || system.count === 0) {
        return uploadedVersion;
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
}

export function writeBillboardSystemUboIfDirty(device: GPUDevice, uniformBuffer: GPUBuffer, scratchUbo: Float32Array, lastUbo: Float32Array, alreadyUploaded: boolean): boolean {
    let dirty = !alreadyUploaded;
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
    return true;
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
        deviceCache = { _shaderModule: null, _pipelines: new Map() };
        cache._devices.set(engine.device, deviceCache);
    }
    cache._lastDeviceCache = deviceCache;
    return deviceCache;
}

function getShaderModule(engine: EngineContextInternal, cache: BillboardPipelineDeviceCache): GPUShaderModule {
    cache._shaderModule ??= engine.device.createShaderModule({ code: makeFacingBillboardWgsl() });
    return cache._shaderModule;
}

function buildFacingBillboardPipeline(
    engine: EngineContextInternal,
    cache: BillboardPipelineDeviceCache,
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    blendMode: SpriteBlendMode,
    depthStencilFormat: GPUTextureFormat,
    sceneBindGroupLayout: GPUBindGroupLayout
): GPURenderPipeline {
    const device = engine.device;
    const billboardBindGroupLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        ],
    });
    return device.createRenderPipeline({
        label: "facing-billboard-sprite-pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBindGroupLayout, billboardBindGroupLayout] }),
        vertex: {
            module: getShaderModule(engine, cache),
            entryPoint: "vs",
            buffers: [
                {
                    arrayStride: BILLBOARD_INSTANCE_STRIDE_BYTES,
                    stepMode: "instance",
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: "float32x3" },
                        { shaderLocation: 1, offset: 12, format: "float32x2" },
                        { shaderLocation: 2, offset: 20, format: "float32x2" },
                        { shaderLocation: 3, offset: 28, format: "float32x2" },
                        { shaderLocation: 4, offset: 36, format: "float32" },
                        { shaderLocation: 5, offset: 40, format: "float32x2" },
                        { shaderLocation: 6, offset: 48, format: "unorm8x4" },
                    ],
                },
            ],
        },
        fragment: {
            module: getShaderModule(engine, cache),
            entryPoint: "fs",
            targets: [{ format, blend: getBlendModeEntry(blendMode).descriptor, writeMask: GPUColorWrite.ALL }],
        },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: depthStencilFormat, depthCompare: "less-equal", depthWriteEnabled: false },
        multisample: { count: sampleCount },
    });
}
