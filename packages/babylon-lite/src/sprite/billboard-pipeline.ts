import { F32, U32, U16 } from "../engine/typed-arrays.js";
import { BU, SS, CW } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { Mat4 } from "../math/types.js";
import { SCENE_UBO_WGSL } from "../shader/scene-uniforms.js";
import type { BillboardDepthMode, BillboardOrientation, BillboardSpriteSystem } from "./billboard-sprite.js";
import type { SpriteLayerFx } from "./custom-shader-core.js";
import { _getBillboardFxHook } from "./sprite-fx-hook.js";
import { BILLBOARD_INSTANCE_FLOATS_PER_SPRITE, BILLBOARD_INSTANCE_STRIDE_BYTES } from "./billboard-sprite.js";

export interface BillboardPipelineDeviceCache {
    /** @internal */
    _shaderModules: Map<string, GPUShaderModule>;
    /** @internal */
    _pipelines: Map<string, GPURenderPipeline>;
}

export interface BillboardPipelineCache {
    /** @internal */
    _devices: WeakMap<GPUDevice, BillboardPipelineDeviceCache>;
}

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
export const BILLBOARD_INDEX_DATA: Readonly<Uint16Array> = new U16([0, 1, 2, 0, 2, 3]);

export interface BillboardInstanceSortScratch {
    /** @internal */
    _capacity: number;
    /** @internal */
    _sortedInstanceData: Float32Array;
    /** @internal */
    _sortIndices: Uint32Array;
    /** @internal */
    _sortDepths: Float32Array;
}

function getDepthModeEntry(depthMode: BillboardDepthMode): (typeof DEPTH_MODE_TABLE)[BillboardDepthMode] {
    return DEPTH_MODE_TABLE[depthMode];
}

/** @internal Shared by the optional billboard custom-shader composer. */
export function makeBillboardBasisWgsl(orientation: BillboardOrientation): string {
    switch (orientation) {
        case "facing":
            return `struct B {
r: vec3f,
u: vec3f,
};
fn basis(_a: vec3f) -> B {
let r = normalize(vec3f(scene.view[0][0], scene.view[1][0], scene.view[2][0]));
let u = normalize(vec3f(scene.view[0][1], scene.view[1][1], scene.view[2][1]));
return B(r, -u);
}`;
        case "axis-locked":
            return `struct B {
r: vec3f,
u: vec3f,
};
fn basis(_a: vec3f) -> B {
let a = normalize(billboards.axisAndCutoff.xyz);
let cr = normalize(vec3f(scene.view[0][0], scene.view[1][0], scene.view[2][0]));
let pr = cr - a * dot(cr, a);
let pl = length(pr);
let f = select(vec3f(0, 0, 1), vec3f(1, 0, 0), abs(a.z) > 0.999);
let fr = cross(a, f);
let r = select(fr / max(length(fr), 1e-4), pr / max(pl, 1e-4), pl > 1e-4);
return B(r, -a);
}`;
    }
}

function makeBillboardFragmentWgsl(depthMode: BillboardDepthMode): string {
    if (depthMode === "cutout") {
        return `@fragment
fn fs(in: O) -> @location(0) vec4f {
let s = textureSample(atlasTex, atlasSamp, in.uv);
if (s.a < billboards.axisAndCutoff.w) {
discard;
}
return s * in.tint * billboards.opacityMul;
}`;
    }
    return `@fragment
fn fs(in: O) -> @location(0) vec4f {
let s = textureSample(atlasTex, atlasSamp, in.uv);
return s * in.tint * billboards.opacityMul;
}`;
}

function makeBillboardWgsl(orientation: BillboardOrientation, depthMode: BillboardDepthMode): string {
    return `${SCENE_UBO_WGSL}
struct S {
opacityMul: vec4f,
axisAndCutoff: vec4f,
};
@group(1) @binding(0) var<uniform> billboards: S;
@group(1) @binding(1) var atlasTex: texture_2d<f32>;
@group(1) @binding(2) var atlasSamp: sampler;
${makeBillboardBasisWgsl(orientation)}
struct I {
@builtin(vertex_index) vid: u32,
@location(0) p: vec3f,
@location(1) s: vec2f,
@location(2) a: vec2f,
@location(3) b: vec2f,
@location(4) r: f32,
@location(5) o: vec2f,
@location(6) c: vec4f,
};
struct O {
@builtin(position) p: vec4f,
@location(0) uv: vec2f,
@location(1) tint: vec4f,
};
@vertex
fn vs(in: I) -> O {
let q = vec2f(select(0.0, 1.0, in.vid == 1u || in.vid == 2u), select(0.0, 1.0, in.vid >= 2u));
let l = (q - in.o) * in.s;
let cr = cos(in.r);
let sr = sin(in.r);
let r = vec2f(l.x * cr - l.y * sr, l.x * sr + l.y * cr);
let b = basis(in.p);
let wp = in.p + b.r * r.x + b.u * r.y;
var out: O;
out.p = scene.viewProjection * vec4f(wp, 1);
out.uv = mix(in.a, in.b, q);
out.tint = in.c;
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
    engine: EngineContext,
    cache: BillboardPipelineCache,
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    system: BillboardSpriteSystem,
    depthStencilFormat: GPUTextureFormat,
    sceneBindGroupLayout: GPUBindGroupLayout
): GPURenderPipeline {
    const deviceCache = getBillboardPipelineDeviceCache(engine, cache);
    const depthEntry = getDepthModeEntry(system._depthMode);
    const customKey = _getBillboardFxHook()?.pipelineKeyPart(system) ?? "";
    const key = `${format}:${sampleCount}:${system._orientation}:${system.blendMode._key}:${depthEntry.index}:${depthStencilFormat}:${customKey}`;
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
        usage: BU.VERTEX | BU.COPY_DST,
    });
}

export function createBillboardInstanceSortScratch(): BillboardInstanceSortScratch {
    return {
        _capacity: 0,
        _sortedInstanceData: new F32(0),
        _sortIndices: new U32(0),
        _sortDepths: new F32(0),
    };
}

export function uploadSortedBillboardInstances(
    device: GPUDevice,
    system: BillboardSpriteSystem,
    instanceBuffer: GPUBuffer,
    scratch: BillboardInstanceSortScratch,
    cameraViewMatrix: Mat4,
    foX = 0,
    foY = 0,
    foZ = 0
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
    // Under floating origin the camera offset (foX/foY/foZ) is subtracted from each
    // anchor so the GPU receives eye-relative positions that match the eye-relative
    // view-projection. The sort depth is computed from the same eye-relative anchor.
    // With a zero offset this is identical to the raw-anchor path.
    for (let index = 0; index < count; index++) {
        const base = index * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE;
        const anchorX = sourceData[base]! - foX;
        const anchorY = sourceData[base + 1]! - foY;
        const anchorZ = sourceData[base + 2]! - foZ;
        indices[index] = index;
        depths[index] = cameraViewMatrix[2]! * anchorX + cameraViewMatrix[6]! * anchorY + cameraViewMatrix[10]! * anchorZ + cameraViewMatrix[14]!;
    }
    indices.subarray(0, count).sort((left, right) => depths[right]! - depths[left]! || left - right);
    for (let outIndex = 0; outIndex < count; outIndex++) {
        const sourceBase = indices[outIndex]! * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE;
        const destBase = outIndex * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE;
        sortedData[destBase] = sourceData[sourceBase]! - foX;
        sortedData[destBase + 1] = sourceData[sourceBase + 1]! - foY;
        sortedData[destBase + 2] = sourceData[sourceBase + 2]! - foZ;
        for (let field = 3; field < BILLBOARD_INSTANCE_FLOATS_PER_SPRITE; field++) {
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

export function uploadBillboardInstances(
    device: GPUDevice,
    system: BillboardSpriteSystem,
    instanceBuffer: GPUBuffer,
    uploadedVersion: number,
    foX = 0,
    foY = 0,
    foZ = 0,
    foScratch: BillboardInstanceSortScratch | null = null
): number {
    if (uploadedVersion === system._version) {
        return uploadedVersion;
    }
    if (system.count === 0) {
        system._dirtyMin = 0;
        system._dirtyMax = 0;
        return system._version;
    }
    // Floating-origin path: anchors live at world scale (~5e6), so they must be made
    // eye-relative (offset subtracted) before upload — otherwise the eye-relative
    // view-projection in the shader would cancel catastrophically in F32. The whole
    // range is re-uploaded because every anchor depends on the live camera offset.
    if ((foX !== 0 || foY !== 0 || foZ !== 0) && foScratch) {
        const count = system.count;
        ensureBillboardInstanceSortScratch(foScratch, count);
        const sourceData = system._instanceData;
        const dest = foScratch._sortedInstanceData;
        for (let index = 0; index < count; index++) {
            const base = index * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE;
            dest[base] = sourceData[base]! - foX;
            dest[base + 1] = sourceData[base + 1]! - foY;
            dest[base + 2] = sourceData[base + 2]! - foZ;
            for (let field = 3; field < BILLBOARD_INSTANCE_FLOATS_PER_SPRITE; field++) {
                dest[base + field] = sourceData[base + field]!;
            }
        }
        device.queue.writeBuffer(instanceBuffer, 0, dest.buffer, dest.byteOffset, count * BILLBOARD_INSTANCE_STRIDE_BYTES);
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
    scratch._sortedInstanceData = new F32(count * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE);
    scratch._sortIndices = new U32(count);
    scratch._sortDepths = new F32(count);
}

export function buildBillboardSystemUbo(system: BillboardSpriteSystem, ubo: Float32Array): void {
    const opacity = system.opacity;
    if (system.blendMode._premultipliedOpacity) {
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

export function createBillboardSystemBindGroup(
    engine: EngineContext,
    pipeline: GPURenderPipeline,
    system: BillboardSpriteSystem,
    uniformBuffer: GPUBuffer,
    fx?: SpriteLayerFx | null
): GPUBindGroup {
    const texture = system.atlas.texture;
    const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: texture.view },
        { binding: 2, resource: texture.sampler },
    ];
    if (fx) {
        for (const entry of _getBillboardFxHook()!.bindEntries(fx, 3)) {
            entries.push(entry);
        }
    }
    return engine._device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries,
    });
}

function getBillboardPipelineDeviceCache(engine: EngineContext, cache: BillboardPipelineCache): BillboardPipelineDeviceCache {
    let deviceCache = cache._devices.get(engine._device);
    if (!deviceCache) {
        deviceCache = { _shaderModules: new Map(), _pipelines: new Map() };
        cache._devices.set(engine._device, deviceCache);
    }
    return deviceCache;
}

function getShaderModule(engine: EngineContext, cache: BillboardPipelineDeviceCache, system: BillboardSpriteSystem): GPUShaderModule {
    const orientation = system._orientation;
    const depthMode = system._depthMode;
    const customModule = _getBillboardFxHook()?.shaderModule(engine, system);
    if (customModule) {
        return customModule;
    }
    const key = `${orientation}:${getDepthModeEntry(depthMode).index}`;
    let module = cache._shaderModules.get(key);
    if (!module) {
        module = engine._device.createShaderModule({ code: makeBillboardWgsl(orientation, depthMode) });
        cache._shaderModules.set(key, module);
    }
    return module;
}

function buildBillboardPipeline(
    engine: EngineContext,
    cache: BillboardPipelineDeviceCache,
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    system: BillboardSpriteSystem,
    depthStencilFormat: GPUTextureFormat,
    sceneBindGroupLayout: GPUBindGroupLayout
): GPURenderPipeline {
    const device = engine._device;
    const depthEntry = getDepthModeEntry(system._depthMode);
    const shaderModule = getShaderModule(engine, cache, system);
    const layoutEntries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: SS.VERTEX | SS.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: SS.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: SS.FRAGMENT, sampler: { type: "filtering" } },
    ];
    const extraLayoutEntries = _getBillboardFxHook()?.layoutEntries(system, 3);
    if (extraLayoutEntries) {
        for (const entry of extraLayoutEntries) {
            layoutEntries.push(entry);
        }
    }
    const billboardBindGroupLayout = device.createBindGroupLayout({ entries: layoutEntries });
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
            targets: [system.blendMode._descriptor ? { format, blend: system.blendMode._descriptor, writeMask: CW.ALL } : { format, writeMask: CW.ALL }],
        },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: depthStencilFormat, depthCompare: "greater-equal", depthWriteEnabled: depthEntry.writeEnabled },
        multisample: { count: sampleCount },
    });
}
