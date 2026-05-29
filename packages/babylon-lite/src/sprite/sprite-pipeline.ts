/** Internal sprite pipeline helpers: owns WGSL, bind-group schema, pipeline construction, and bind-group creation. */
import type { EngineContextInternal } from "../engine/engine.js";
import type { Sprite2DLayer, SpriteBlendMode } from "./sprite-2d.js";
import { DEPTH_INSTANCE_STRIDE_BYTES, PURE_2D_INSTANCE_STRIDE_BYTES } from "./sprite-2d.js";

export interface SpritePipelineDeviceCache {
    _shaderModule: GPUShaderModule | null;
    _sceneShaderModule: GPUShaderModule | null;
    _pipelines: Map<string, GPURenderPipeline>;
}

export interface SpritePipelineCache {
    _devices: WeakMap<GPUDevice, SpritePipelineDeviceCache>;
}

const SPRITE_POSITION_OFFSET_BYTES = 0;
const SPRITE_SIZE_OFFSET_BYTES = 8;
const SPRITE_UV_MIN_OFFSET_BYTES = 16;
const SPRITE_UV_MAX_OFFSET_BYTES = 24;
const SPRITE_ROTATION_OFFSET_BYTES = 32;
const SPRITE_COLOR_OFFSET_BYTES = 36;
const SPRITE_DEPTH_OFFSET_BYTES = 52;

function makeSpriteWgsl(hasDepth: boolean, spriteGroupIndex: 0 | 1): string {
    const group = `@group(${spriteGroupIndex})`;
    const zAttribute = hasDepth ? `,\n@location(6) iZ: f32` : "";
    const zPosition = hasDepth ? "1.0 - in.iZ" : "0.0";
    return `struct Layer {
viewPos: vec2<f32>,
viewScale: f32,
viewRot: f32,
screenSize: vec2<f32>,
pivot: vec2<f32>,
// Per-layer opacity, pre-shaped for the layer's blend mode (CPU-side):
//   straight-alpha:  (1, 1, 1, opacity)  — only alpha is scaled
//   premultiplied:   (opacity, opacity, opacity, opacity) — RGB and A scale together
// One uniform, no shader branch.
opacityMul: vec4<f32>,
};
${group} @binding(0) var<uniform> L: Layer;
${group} @binding(1) var atlasTex: texture_2d<f32>;
${group} @binding(2) var atlasSamp: sampler;
struct VIn {
@builtin(vertex_index) vid: u32,
@location(0) iPos: vec2<f32>,
@location(1) iSize: vec2<f32>,
@location(2) iUvMin: vec2<f32>,
@location(3) iUvMax: vec2<f32>,
@location(4) iRot: f32,
@location(5) iColor: vec4<f32>${zAttribute}
};
struct VOut {
@builtin(position) pos: vec4<f32>,
@location(0) uv: vec2<f32>,
@location(1) tint: vec4<f32>,
};
@vertex
fn vs(in: VIn) -> VOut {
var corners = array<vec2<f32>, 4>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0));
let c = corners[in.vid];
let local = (c - L.pivot) * in.iSize;
let cr = cos(in.iRot);
let sr = sin(in.iRot);
let rotated = vec2<f32>(local.x * cr - local.y * sr, local.x * sr + local.y * cr);
let layerPx = in.iPos + rotated;
let centered = layerPx - L.viewPos;
let lc = cos(L.viewRot);
let ls = sin(L.viewRot);
let viewRot = vec2<f32>(centered.x * lc - centered.y * ls, centered.x * ls + centered.y * lc);
let screenPx = viewRot * L.viewScale;
let ndc = vec2<f32>(screenPx.x / L.screenSize.x * 2.0 - 1.0, 1.0 - screenPx.y / L.screenSize.y * 2.0);
let uv = mix(in.iUvMin, in.iUvMax, c);
var out: VOut;
out.pos = vec4<f32>(ndc, ${zPosition}, 1.0);
out.uv = uv;
out.tint = in.iColor;
return out;
}
@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
let s = textureSample(atlasTex, atlasSamp, in.uv);
return s * in.tint * L.opacityMul;
}`;
}

type SupportedSpriteBlendMode = Extract<SpriteBlendMode, "alpha" | "premultiplied">;

const BLEND_MODE_TABLE: Readonly<Record<SupportedSpriteBlendMode, { index: number; descriptor: GPUBlendState }>> = {
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

function getBlendModeEntry(blendMode: SpriteBlendMode): (typeof BLEND_MODE_TABLE)[SupportedSpriteBlendMode] {
    if (blendMode === "alpha" || blendMode === "premultiplied") {
        return BLEND_MODE_TABLE[blendMode];
    }
    throw new Error(`Sprite pipeline: blendMode: "${blendMode}" is not supported yet.`);
}

export function createSpritePipelineCache(): SpritePipelineCache {
    return {
        _devices: new WeakMap(),
    };
}

export function resetSpritePipelineCache(cache: SpritePipelineCache): void {
    cache._devices = new WeakMap();
}

export function getSpritePipelineCacheSize(cache: SpritePipelineCache, device: GPUDevice): number {
    return cache._devices.get(device)?._pipelines.size ?? 0;
}

export function getOrCreateSpritePipeline(
    engine: EngineContextInternal,
    cache: SpritePipelineCache,
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    blendMode: SpriteBlendMode,
    hasDepth: boolean,
    depthWrite = false,
    depthStencilFormat?: GPUTextureFormat,
    sceneBindGroupLayout?: GPUBindGroupLayout
): GPURenderPipeline {
    const deviceCache = getSpritePipelineDeviceCache(engine, cache);
    const resolvedDepthStencilFormat = normalizeDepthStencilFormat(hasDepth, depthStencilFormat);
    const key = spritePipelineKey(format, sampleCount, blendMode, hasDepth, depthWrite, resolvedDepthStencilFormat);
    const cached = deviceCache._pipelines.get(key);
    if (cached) {
        return cached;
    }

    const pipeline = buildSpritePipeline(engine, deviceCache, format, sampleCount, blendMode, hasDepth, depthWrite, resolvedDepthStencilFormat, sceneBindGroupLayout);
    deviceCache._pipelines.set(key, pipeline);
    return pipeline;
}

export function createSpriteLayerBindGroup(
    engine: EngineContextInternal,
    pipeline: GPURenderPipeline,
    spriteBindGroupIndex: 0 | 1,
    layer: Sprite2DLayer,
    uniformBuffer: GPUBuffer
): GPUBindGroup {
    const tex = layer.atlas.texture;
    return engine.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(spriteBindGroupIndex),
        entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: tex.view },
            { binding: 2, resource: tex.sampler },
        ],
    });
}

function getSpritePipelineDeviceCache(engine: EngineContextInternal, cache: SpritePipelineCache): SpritePipelineDeviceCache {
    let deviceCache = cache._devices.get(engine.device);
    if (!deviceCache) {
        deviceCache = {
            _shaderModule: null,
            _sceneShaderModule: null,
            _pipelines: new Map(),
        };
        cache._devices.set(engine.device, deviceCache);
    }
    return deviceCache;
}

function normalizeDepthStencilFormat(hasDepth: boolean, depthStencilFormat?: GPUTextureFormat): GPUTextureFormat | null {
    if (!hasDepth) {
        return null;
    }
    if (!depthStencilFormat) {
        throw new Error("Sprite pipeline: depth-enabled pipelines require a depth-stencil format.");
    }
    return depthStencilFormat;
}

function spritePipelineKey(
    format: GPUTextureFormat,
    sampleCount: number,
    blendMode: SpriteBlendMode,
    hasDepth: boolean,
    depthWrite: boolean,
    depthStencilFormat: GPUTextureFormat | null
): string {
    return `${format}:${sampleCount}:${getBlendModeEntry(blendMode).index}:${hasDepth ? 1 : 0}:${depthWrite ? 1 : 0}:${depthStencilFormat ?? "-"}`;
}

function getShaderModule(engine: EngineContextInternal, cache: SpritePipelineDeviceCache, hasDepth: boolean): GPUShaderModule {
    if (hasDepth) {
        cache._sceneShaderModule ??= engine.device.createShaderModule({ code: makeSpriteWgsl(true, 1) });
        return cache._sceneShaderModule;
    }
    cache._shaderModule ??= engine.device.createShaderModule({ code: makeSpriteWgsl(false, 0) });
    return cache._shaderModule;
}

function buildSpritePipeline(
    engine: EngineContextInternal,
    cache: SpritePipelineDeviceCache,
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    blendMode: SpriteBlendMode,
    hasDepth: boolean,
    depthWrite: boolean,
    depthStencilFormat: GPUTextureFormat | null,
    sceneBindGroupLayout?: GPUBindGroupLayout
): GPURenderPipeline {
    const device = engine.device;
    const bindGroupLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        ],
    });
    const module = getShaderModule(engine, cache, hasDepth);
    if (hasDepth && !sceneBindGroupLayout) {
        throw new Error("Sprite pipeline: depth-enabled pipelines require a scene bind-group layout.");
    }
    const bindGroupLayouts = hasDepth ? [sceneBindGroupLayout!, bindGroupLayout] : [bindGroupLayout];
    const instanceAttributes: GPUVertexAttribute[] = [
        { shaderLocation: 0, offset: SPRITE_POSITION_OFFSET_BYTES, format: "float32x2" },
        { shaderLocation: 1, offset: SPRITE_SIZE_OFFSET_BYTES, format: "float32x2" },
        { shaderLocation: 2, offset: SPRITE_UV_MIN_OFFSET_BYTES, format: "float32x2" },
        { shaderLocation: 3, offset: SPRITE_UV_MAX_OFFSET_BYTES, format: "float32x2" },
        { shaderLocation: 4, offset: SPRITE_ROTATION_OFFSET_BYTES, format: "float32" },
        { shaderLocation: 5, offset: SPRITE_COLOR_OFFSET_BYTES, format: "float32x4" },
    ];
    if (hasDepth) {
        instanceAttributes.push({ shaderLocation: 6, offset: SPRITE_DEPTH_OFFSET_BYTES, format: "float32" });
    }
    const descriptor: GPURenderPipelineDescriptor = {
        layout: device.createPipelineLayout({ bindGroupLayouts }),
        vertex: {
            module,
            entryPoint: "vs",
            buffers: [
                {
                    arrayStride: hasDepth ? DEPTH_INSTANCE_STRIDE_BYTES : PURE_2D_INSTANCE_STRIDE_BYTES,
                    stepMode: "instance",
                    attributes: instanceAttributes,
                },
            ],
        },
        fragment: {
            module,
            entryPoint: "fs",
            targets: [{ format, blend: getBlendModeEntry(blendMode).descriptor, writeMask: GPUColorWrite.ALL }],
        },
        primitive: { topology: "triangle-list", cullMode: "none" },
        multisample: { count: sampleCount },
    };
    if (hasDepth) {
        descriptor.depthStencil = {
            format: depthStencilFormat!,
            depthCompare: "greater-equal",
            depthWriteEnabled: depthWrite,
        };
    }
    return device.createRenderPipeline(descriptor);
}

// ─── Per-layer GPU sync helpers ────────────────────────────────────────────
// Shared by `sprite-renderer.ts` (multi-layer pure-2D pass) and
// `sprite-renderable.ts` (single-layer depth-hosted scene `Renderable`).
// The two consumers have different lifecycles (renderer caches a `LayerGpu`
// per layer; renderable owns one `Sprite2DLayer`) but the per-frame work —
// "grow instance buffer if needed", "upload dirty instance range",
// "build the 12-float UBO", "writeBuffer only if changed" — is identical.

/** Per-layer UBO size in bytes. 12 floats; struct alignment forced to 16 by `vec4<f32>` fields. */
export const LAYER_UBO_BYTES = 48;
/** Number of floats in the per-layer UBO scratch / lastUbo arrays. */
export const LAYER_UBO_FLOATS = LAYER_UBO_BYTES / 4;

/** Shared two-triangle quad index buffer source (4 corners → 6 indices). */
export const SHARED_SPRITE_INDEX_DATA: Readonly<Uint16Array> = new Uint16Array([0, 1, 2, 0, 2, 3]);

/** Allocate a per-layer instance vertex buffer sized for `capacity` sprites. */
export function createSpriteInstanceBuffer(device: GPUDevice, layer: Sprite2DLayer, label?: string): GPUBuffer {
    return device.createBuffer({
        size: layer._capacity * layer._instanceStrideBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label,
    });
}

/**
 * Reallocate the instance buffer if `layer._capacity` outgrew the current GPU buffer.
 * Returns the (possibly new) buffer + the new capacity, plus a `reallocated` flag the
 * caller uses to invalidate per-buffer caches (render bundles, `uploadedVersion`, etc).
 */
export function ensureSpriteInstanceBuffer(
    device: GPUDevice,
    layer: Sprite2DLayer,
    currentBuffer: GPUBuffer,
    currentCapacity: number,
    label?: string
): { buffer: GPUBuffer; capacity: number; reallocated: boolean } {
    if (currentCapacity >= layer._capacity) {
        return { buffer: currentBuffer, capacity: currentCapacity, reallocated: false };
    }
    currentBuffer.destroy();
    return {
        buffer: createSpriteInstanceBuffer(device, layer, label),
        capacity: layer._capacity,
        reallocated: true,
    };
}

/**
 * Sync per-instance vertex data to `instanceBuffer`. Returns the new `uploadedVersion`
 * the caller should store. No-op if `layer._version` hasn't advanced or the layer is
 * empty. On first sight (`uploadedVersion === -1`) uploads `[0, count)`; on subsequent
 * edits uploads only `[_dirtyMin, min(_dirtyMax, count))`. Resets the dirty range.
 */
export function uploadSpriteInstances(device: GPUDevice, layer: Sprite2DLayer, instanceBuffer: GPUBuffer, uploadedVersion: number): number {
    if (uploadedVersion === layer._version) {
        return uploadedVersion;
    }
    if (layer.count === 0) {
        layer._dirtyMin = 0;
        layer._dirtyMax = 0;
        return layer._version;
    }
    let lo: number;
    let hi: number;
    if (uploadedVersion === -1) {
        lo = 0;
        hi = layer.count;
    } else {
        lo = layer._dirtyMin;
        hi = Math.min(layer._dirtyMax, layer.count);
    }
    if (hi > lo) {
        const offsetBytes = lo * layer._instanceStrideBytes;
        const bytes = (hi - lo) * layer._instanceStrideBytes;
        device.queue.writeBuffer(instanceBuffer, offsetBytes, layer._instanceData.buffer, layer._instanceData.byteOffset + offsetBytes, bytes);
    }
    layer._dirtyMin = 0;
    layer._dirtyMax = 0;
    return layer._version;
}

/**
 * Fill `ubo` (12 floats) with the per-layer UBO contents from `layer` at the given
 * render-target dims. Layout matches the WGSL `Layer` struct (48 bytes total):
 *   [0..1]  viewPos.xy   [2] viewScale   [3] viewRot
 *   [4..5]  screenSize.xy   [6..7] pivot.xy
 *   [8..11] opacityMul.rgba (pre-shaped per blend mode)
 *
 * Depth-hosted layers keep per-sprite NDC depth on the per-instance vertex buffer
 * (slot [13] of `Sprite2DLayer._instanceData`), not in this UBO — a single
 * depth-hosted layer can mix sprites at different depths. Pure-2D layers have no
 * Z slot.
 *
 * Premultiplied sources need RGB *and* A scaled by opacity for a correct fade;
 * straight-alpha needs only A scaled (the blend stage already uses src.a as factor).
 */
export function buildSpriteLayerUbo(layer: Sprite2DLayer, screenWidth: number, screenHeight: number, ubo: Float32Array): void {
    ubo[0] = layer.view.positionPx[0];
    ubo[1] = layer.view.positionPx[1];
    ubo[2] = layer.view.zoom;
    ubo[3] = layer.view.rotation;
    ubo[4] = screenWidth;
    ubo[5] = screenHeight;
    ubo[6] = layer.pivot[0];
    ubo[7] = layer.pivot[1];
    const op = layer.opacity;
    if (layer.blendMode === "premultiplied") {
        ubo[8] = op;
        ubo[9] = op;
        ubo[10] = op;
        ubo[11] = op;
    } else {
        ubo[8] = 1;
        ubo[9] = 1;
        ubo[10] = 1;
        ubo[11] = op;
    }
}

/**
 * Compare `scratchUbo` to `lastUbo` (LAYER_UBO_FLOATS each) and `writeBuffer` only if they
 * differ. On first call (`alreadyUploaded === false`) forces an unconditional write
 * so `lastUbo` becomes real. Returns the new `alreadyUploaded` value (always `true`
 * after the first call regardless of whether bytes changed).
 */
export function writeSpriteLayerUboIfDirty(device: GPUDevice, uniformBuffer: GPUBuffer, scratchUbo: Float32Array, lastUbo: Float32Array, alreadyUploaded: boolean): boolean {
    let dirty = !alreadyUploaded;
    if (!dirty) {
        for (let i = 0; i < LAYER_UBO_FLOATS; i++) {
            if (lastUbo[i] !== scratchUbo[i]) {
                dirty = true;
                break;
            }
        }
    }
    if (dirty) {
        device.queue.writeBuffer(uniformBuffer, 0, scratchUbo.buffer, scratchUbo.byteOffset, LAYER_UBO_BYTES);
        lastUbo.set(scratchUbo);
    }
    return true;
}
