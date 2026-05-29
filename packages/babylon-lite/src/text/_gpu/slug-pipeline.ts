/** Owns the text render pipeline + bind-group layouts. Lazy per-device cache. */

import type { EngineContextInternal } from "../../engine/engine.js";
import { getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { SCENE_UBO_WGSL } from "../../shader/scene-uniforms.js";
import vertSrc from "../shaders/slug.vert.wgsl?raw";
import fragSrc from "../shaders/slug.frag.wgsl?raw";
import { TEXT_INSTANCE_BYTES } from "../text-data.js";

export interface TextPipelineDeviceCache {
    bgl1: GPUBindGroupLayout;
    vertModule: GPUShaderModule;
    fragModule: GPUShaderModule;
    quadVertexBuffer: GPUBuffer;
    pipelines: Map<string, GPURenderPipeline>;
}

let _cache: WeakMap<GPUDevice, TextPipelineDeviceCache> | null = null;

/** Shared 4-vertex unit quad: corner signs (-1,-1), (1,-1), (1,1), (-1,1). */
const QUAD_CORNERS = [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1] as const;

function getOrCreateDeviceCache(engine: EngineContextInternal): TextPipelineDeviceCache {
    _cache ??= new WeakMap();
    let cache = _cache.get(engine.device);
    if (cache) {
        return cache;
    }
    const device = engine.device;
    const bgl1 = device.createBindGroupLayout({
        label: "text-bgl1",
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        ],
    });
    const vertModule = device.createShaderModule({ label: "text-vert", code: SCENE_UBO_WGSL + "\n" + vertSrc });
    const fragModule = device.createShaderModule({ label: "text-frag", code: fragSrc });
    const corners = new Float32Array(QUAD_CORNERS);
    const quadVertexBuffer = device.createBuffer({
        label: "text-quad-corners",
        size: corners.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
    });
    new Float32Array(quadVertexBuffer.getMappedRange()).set(corners);
    quadVertexBuffer.unmap();

    cache = { bgl1, vertModule, fragModule, quadVertexBuffer, pipelines: new Map() };
    _cache.set(device, cache);
    return cache;
}

function pipelineKey(format: GPUTextureFormat, sampleCount: number, depthStencilFormat: GPUTextureFormat | null, depthWrite: boolean, flipY: boolean): string {
    return format + ":" + sampleCount + ":" + (depthStencilFormat ?? "-") + ":" + (depthWrite ? "w" : "r") + ":" + (flipY ? "y" : "n");
}

export function getOrCreateTextPipeline(
    engine: EngineContextInternal,
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    depthStencilFormat: GPUTextureFormat | null,
    depthWrite: boolean,
    flipY: boolean
): { pipeline: GPURenderPipeline; cache: TextPipelineDeviceCache } {
    const cache = getOrCreateDeviceCache(engine);
    const key = pipelineKey(format, sampleCount, depthStencilFormat, depthWrite, flipY);
    let pipeline = cache.pipelines.get(key);
    if (pipeline) {
        return { pipeline, cache };
    }
    const device = engine.device;
    const sceneBGL = getSceneBindGroupLayout(engine);
    const descriptor: GPURenderPipelineDescriptor = {
        label: "text-pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBGL, cache.bgl1] }),
        vertex: {
            module: cache.vertModule,
            entryPoint: "main",
            buffers: [
                {
                    arrayStride: 8,
                    stepMode: "vertex",
                    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
                },
                {
                    arrayStride: TEXT_INSTANCE_BYTES,
                    stepMode: "instance",
                    attributes: [
                        { shaderLocation: 1, offset: 0, format: "float32x4" },
                        { shaderLocation: 2, offset: 16, format: "float32x4" },
                        { shaderLocation: 3, offset: 32, format: "float32x4" },
                        { shaderLocation: 4, offset: 48, format: "float32x4" },
                    ],
                },
            ],
        },
        fragment: {
            module: cache.fragModule,
            entryPoint: "main",
            targets: [
                {
                    format,
                    blend: {
                        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                    },
                },
            ],
        },
        primitive: { topology: "triangle-list", cullMode: "none", frontFace: flipY ? "cw" : "ccw" },
        multisample: { count: sampleCount },
    };
    if (depthStencilFormat) {
        descriptor.depthStencil = {
            format: depthStencilFormat,
            depthCompare: "less-equal",
            depthWriteEnabled: depthWrite,
        };
    }
    pipeline = device.createRenderPipeline(descriptor);
    cache.pipelines.set(key, pipeline);
    return { pipeline, cache };
}
