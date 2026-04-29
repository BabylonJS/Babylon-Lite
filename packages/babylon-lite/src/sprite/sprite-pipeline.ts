/** Internal sprite pipeline helpers: owns WGSL, bind-group schema, pipeline construction, and bind-group creation. */
import type { EngineContextInternal } from "../engine/engine.js";
import type { Sprite2DLayer, SpriteBlendMode } from "./sprite-2d.js";
import { INSTANCE_STRIDE_BYTES } from "./sprite-2d.js";

export interface SpritePipelineEntry {
    readonly device: GPUDevice;
    readonly format: GPUTextureFormat;
    readonly msaaSamples: number;
    readonly pipeline: GPURenderPipeline;
    readonly bindGroupLayout: GPUBindGroupLayout;
}

export interface SpritePipelineCache {
    _device: GPUDevice | null;
    _format: GPUTextureFormat | null;
    _msaaSamples: number;
    _shaderModule: GPUShaderModule | null;
    _entries: Map<string, SpritePipelineEntry>;
}

const WGSL_SHADER = `struct Layer {
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
@group(0) @binding(0) var<uniform> L: Layer;
@group(0) @binding(1) var atlasTex: texture_2d<f32>;
@group(0) @binding(2) var atlasSamp: sampler;
struct VIn {
@builtin(vertex_index) vid: u32,
@location(0) iPos: vec2<f32>,
@location(1) iSize: vec2<f32>,
@location(2) iUvMin: vec2<f32>,
@location(3) iUvMax: vec2<f32>,
@location(4) iRot: f32,
@location(5) iColor: vec4<f32>,
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
out.pos = vec4<f32>(ndc, 0.0, 1.0);
out.uv = uv;
out.tint = in.iColor;
return out;
}
@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
let s = textureSample(atlasTex, atlasSamp, in.uv);
return s * in.tint * L.opacityMul;
}`;

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
        _device: null,
        _format: null,
        _msaaSamples: 0,
        _shaderModule: null,
        _entries: new Map(),
    };
}

export function clearSpritePipelineCache(cache: SpritePipelineCache): void {
    cache._entries.clear();
    cache._device = null;
    cache._format = null;
    cache._msaaSamples = 0;
    cache._shaderModule = null;
}

export function getSpritePipelineCacheSize(cache: SpritePipelineCache): number {
    return cache._entries.size;
}

export function isSpritePipelineEntryCurrent(engine: EngineContextInternal, entry: SpritePipelineEntry): boolean {
    return entry.device === engine.device && entry.format === engine.format && entry.msaaSamples === engine.msaaSamples;
}

export function getOrCreateSpritePipeline(engine: EngineContextInternal, cache: SpritePipelineCache, blendMode: SpriteBlendMode, hasDepth: boolean): SpritePipelineEntry {
    ensureCacheMatchesEngine(engine, cache);

    const key = spritePipelineKey(engine.format, engine.msaaSamples, blendMode, hasDepth);
    const cached = cache._entries.get(key);
    if (cached) {
        return cached;
    }

    const entry = buildSpritePipeline(engine, cache, blendMode, hasDepth);
    cache._entries.set(key, entry);
    return entry;
}

export function createSpriteLayerBindGroup(engine: EngineContextInternal, entry: SpritePipelineEntry, layer: Sprite2DLayer, uniformBuffer: GPUBuffer): GPUBindGroup {
    const tex = layer.atlas.texture;
    return engine.device.createBindGroup({
        layout: entry.bindGroupLayout,
        entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: tex.view },
            { binding: 2, resource: tex.sampler },
        ],
    });
}

function ensureCacheMatchesEngine(engine: EngineContextInternal, cache: SpritePipelineCache): void {
    if (cache._device === engine.device && cache._format === engine.format && cache._msaaSamples === engine.msaaSamples) {
        return;
    }
    cache._entries.clear();
    cache._device = engine.device;
    cache._format = engine.format;
    cache._msaaSamples = engine.msaaSamples;
    cache._shaderModule = null;
}

function spritePipelineKey(format: GPUTextureFormat, sampleCount: number, blendMode: SpriteBlendMode, hasDepth: boolean): string {
    return `${format}:${sampleCount}:${getBlendModeEntry(blendMode).index}:${hasDepth ? 1 : 0}`;
}

function getShaderModule(engine: EngineContextInternal, cache: SpritePipelineCache): GPUShaderModule {
    cache._shaderModule ??= engine.device.createShaderModule({ code: WGSL_SHADER });
    return cache._shaderModule;
}

function buildSpritePipeline(engine: EngineContextInternal, cache: SpritePipelineCache, blendMode: SpriteBlendMode, _hasDepth: boolean): SpritePipelineEntry {
    const device = engine.device;
    const bindGroupLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        ],
    });
    const module = getShaderModule(engine, cache);
    const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
        vertex: {
            module,
            entryPoint: "vs",
            buffers: [
                {
                    arrayStride: INSTANCE_STRIDE_BYTES,
                    stepMode: "instance",
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: "float32x2" },
                        { shaderLocation: 1, offset: 8, format: "float32x2" },
                        { shaderLocation: 2, offset: 16, format: "float32x2" },
                        { shaderLocation: 3, offset: 24, format: "float32x2" },
                        { shaderLocation: 4, offset: 32, format: "float32" },
                        { shaderLocation: 5, offset: 36, format: "unorm8x4" },
                    ],
                },
            ],
        },
        fragment: {
            module,
            entryPoint: "fs",
            targets: [{ format: engine.format, blend: getBlendModeEntry(blendMode).descriptor, writeMask: GPUColorWrite.ALL }],
        },
        primitive: { topology: "triangle-list", cullMode: "none" },
        multisample: { count: engine.msaaSamples },
    });

    return { device, format: engine.format, msaaSamples: engine.msaaSamples, pipeline, bindGroupLayout };
}
