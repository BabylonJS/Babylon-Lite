/**
 * Sprite2DLayer renderable builder.
 *
 * Dynamic-imported by the layer's deferred build hook so that scenes which
 * never use sprites pay zero bytes.
 *
 * Owns: pipeline (cache), bind groups, layer UBO, instance buffer sync.
 */

import type { EngineContextInternal } from "../engine/engine.js";
import type { Renderable } from "../render/renderable.js";
import type { Sprite2DLayer } from "./sprite-2d.js";
import { SPRITE_2D_STRIDE } from "./sprite-2d.js";
import type { SpriteBlendMode } from "./shared/sprite-atlas.js";
import { syncSpriteStorage, disposeSpriteStorage } from "./shared/sprite-gpu.js";
import { composeSprite2D } from "./sprite-2d-shader.js";
import { createPipelineCache, type PipelineCache, type PipelineCacheEntry } from "../material/pipeline-cache.js";

/** SpriteLayerUBO (32 bytes — opacity at offset 0, then padded vec3 to satisfy WGSL alignment). */
const SPRITE_LAYER_UBO_BYTES = 32;

interface Sprite2DPipelineVariant extends PipelineCacheEntry {
    pipeline: GPURenderPipeline;
    sceneBGL: GPUBindGroupLayout;
    layerBGL: GPUBindGroupLayout;
}

let _cache: PipelineCache<Sprite2DPipelineVariant> | null = null;
function getCache(): PipelineCache<Sprite2DPipelineVariant> {
    if (!_cache) {
        _cache = createPipelineCache();
    }
    return _cache;
}

function blendState(mode: SpriteBlendMode): GPUBlendState | undefined {
    switch (mode) {
        case "alpha":
            return {
                color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            };
        case "premultiplied":
            return {
                color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            };
        case "additive":
            return {
                color: { srcFactor: "one", dstFactor: "one", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            };
        case "multiply":
            return {
                color: { srcFactor: "dst", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            };
        case "cutout":
            return undefined;
    }
}

function pipelineKey(format: GPUTextureFormat, msaaSamples: number, blend: SpriteBlendMode, pixelSnap: boolean, alphaCutoff: number, hasDepth: boolean): string {
    return `s2d|${format}|${msaaSamples}|${blend}|${pixelSnap ? 1 : 0}|${alphaCutoff.toFixed(4)}|${hasDepth ? 1 : 0}`;
}

function getOrCreatePipeline(engine: EngineContextInternal, format: GPUTextureFormat, msaaSamples: number, layer: Sprite2DLayer, hasDepth: boolean): Sprite2DPipelineVariant {
    const cache = getCache();
    cache.ensureDevice(engine);
    const key = pipelineKey(format, msaaSamples, layer.blendMode, layer.pixelSnap, layer.alphaCutoff, hasDepth);
    const hit = cache.getOrIncRef(key);
    if (hit) {
        return hit;
    }
    const device = engine.device;
    const composed = composeSprite2D({ pixelSnap: layer.pixelSnap, blendMode: layer.blendMode, alphaCutoff: layer.alphaCutoff });
    const sceneBGL = device.createBindGroupLayout({
        label: "sprite2d-scene-bgl",
        entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    const layerBGL = device.createBindGroupLayout({
        label: "sprite2d-layer-bgl",
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        ],
    });

    const vertModule = device.createShaderModule({ code: composed.vertexWGSL, label: "sprite2d-vert" });
    const fragModule = device.createShaderModule({ code: composed.fragmentWGSL, label: "sprite2d-frag" });

    // Per-instance attribute layout (stride 80 B = 20 floats):
    //   pos2 (8) | size2 (8) | pivot2 (8) | sinCos2 (8) | uvRect4 (16) | color4 (16) | layerZ (4) | flipX (4) | flipY (4) | _pad (4)
    const instanceLayout: GPUVertexBufferLayout = {
        arrayStride: SPRITE_2D_STRIDE * 4,
        stepMode: "instance",
        attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x2" },
            { shaderLocation: 2, offset: 16, format: "float32x2" },
            { shaderLocation: 3, offset: 24, format: "float32x2" },
            { shaderLocation: 4, offset: 32, format: "float32x4" },
            { shaderLocation: 5, offset: 48, format: "float32x4" },
            { shaderLocation: 6, offset: 64, format: "float32" },
            { shaderLocation: 7, offset: 68, format: "float32" },
            { shaderLocation: 8, offset: 72, format: "float32" },
        ],
    };

    const colorTarget: GPUColorTargetState = { format, blend: blendState(layer.blendMode) };

    const pipelineDesc: GPURenderPipelineDescriptor = {
        label: "sprite2d-pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBGL, layerBGL] }),
        vertex: { module: vertModule, entryPoint: "vs_main", buffers: [instanceLayout] },
        fragment: { module: fragModule, entryPoint: "fs_main", targets: [colorTarget] },
        primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
        multisample: { count: msaaSamples },
    };
    if (hasDepth) {
        pipelineDesc.depthStencil = {
            format: "depth24plus-stencil8",
            depthCompare: "always",
            depthWriteEnabled: false,
        };
    }
    const pipeline = device.createRenderPipeline(pipelineDesc);

    const variant: Sprite2DPipelineVariant = { pipeline, sceneBGL, layerBGL, refCount: 1 };
    cache.set(key, variant);
    return variant;
}

export interface Sprite2DBuildContext {
    engine: EngineContextInternal;
    /** Output color format for the render pass (swap chain or offscreen). */
    format: GPUTextureFormat;
    /** MSAA sample count for the render pass. 1 for Scene2DContext; matches scene MSAA for overlay use. */
    msaaSamples: number;
    /** True when the renderable will execute inside a render pass that has a depth attachment (overlay use). */
    hasDepth: boolean;
    /** Shared scene UBO (32 B). May be a single buffer reused across all sprite-2d layers in the scene. */
    sceneUBO: GPUBuffer;
}

export interface Sprite2DBuildResult {
    renderable: Renderable;
    /** Layer-local cleanup (UBO, instance GPU buffer, layer bind group). */
    dispose: () => void;
}

/** Build a Renderable for a Sprite2DLayer. Caller is responsible for the scene UBO + its updater. */
export function buildSprite2DRenderable(layer: Sprite2DLayer, ctx: Sprite2DBuildContext): Sprite2DBuildResult {
    const variant = getOrCreatePipeline(ctx.engine, ctx.format, ctx.msaaSamples, layer, ctx.hasDepth);
    const device = ctx.engine.device;

    const layerUBO = device.createBuffer({
        label: "sprite2d-layer-ubo",
        size: SPRITE_LAYER_UBO_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const layerScratch = new Float32Array(SPRITE_LAYER_UBO_BYTES / 4);

    const sceneBG = device.createBindGroup({
        label: "sprite2d-scene-bg",
        layout: variant.sceneBGL,
        entries: [{ binding: 0, resource: { buffer: ctx.sceneUBO } }],
    });

    const layerBG = device.createBindGroup({
        label: "sprite2d-layer-bg",
        layout: variant.layerBGL,
        entries: [
            { binding: 0, resource: layer.atlas.texture.view },
            { binding: 1, resource: layer.atlas.texture.sampler },
            { binding: 2, resource: { buffer: layerUBO } },
        ],
    });

    const renderable: Renderable = {
        order: 200 + layer.order,
        isTransparent: layer.blendMode !== "cutout",
        _pipeline: variant.pipeline,
        _sceneBG: sceneBG,
        updateUBOs(): void {
            // Update per-layer UBO every frame — opacity is animation-friendly.
            layerScratch[0] = layer.opacity;
            device.queue.writeBuffer(layerUBO, 0, layerScratch.buffer, layerScratch.byteOffset, SPRITE_LAYER_UBO_BYTES);
            // CPU→GPU sync of instance data.
            syncSpriteStorage(ctx.engine, layer._storage, "sprite2d-instances");
        },
        draw(pass): number {
            if (!layer.visible || layer._storage.count === 0 || !layer._storage.gpuBuffer) {
                return 0;
            }
            pass.setBindGroup(1, layerBG);
            pass.setVertexBuffer(0, layer._storage.gpuBuffer);
            pass.draw(6, layer._storage.count);
            return 1;
        },
    };

    const dispose = (): void => {
        layerUBO.destroy();
        disposeSpriteStorage(layer._storage);
    };

    return { renderable, dispose };
}
