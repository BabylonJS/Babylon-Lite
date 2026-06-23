/** Owns the text render pipeline + bind-group layouts. Lazy per-device cache. */

import type { EngineContext } from "../../engine/engine.js";
import vertSrc from "../shaders/slug.vert.wgsl?raw";
import fragSrc from "../shaders/slug.frag.wgsl?raw";
import { TEXT_INSTANCE_BYTES } from "../text-data.js";

export interface TextPipelineDeviceCache {
    bindGroupLayout: GPUBindGroupLayout;
    vertModule: GPUShaderModule;
    fragModule: GPUShaderModule;
    quadVertexBuffer: GPUBuffer;
    pipelines: Map<string, GPURenderPipeline>;
}

let _cache: WeakMap<GPUDevice, TextPipelineDeviceCache> | null = null;

/** Clear the text pipeline cache for a device, releasing cache-held refs. */
export function clearTextPipelineCache(engine: EngineContext): void {
    _cache?.delete(engine._device);
}

/** Shared 4-vertex unit quad: corner signs (-1,-1), (1,-1), (1,1), (-1,1). */
const QUAD_CORNERS = [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1] as const;

function getOrCreateDeviceCache(engine: EngineContext): TextPipelineDeviceCache {
    _cache ??= new WeakMap();
    let cache = _cache.get(engine._device);
    if (cache) {
        return cache;
    }
    const device = engine._device;
    const bindGroupLayout = device.createBindGroupLayout({
        label: "text-bind-group-layout",
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        ],
    });
    const vertModule = device.createShaderModule({ label: "text-vert", code: vertSrc });
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

    cache = { bindGroupLayout, vertModule, fragModule, quadVertexBuffer, pipelines: new Map() };
    _cache.set(device, cache);
    return cache;
}

function pipelineKey(format: GPUTextureFormat, sampleCount: number, depthStencilFormat: GPUTextureFormat | null, depthWrite: boolean): string {
    return format + ":" + sampleCount + ":" + (depthStencilFormat ?? "-") + ":" + (depthWrite ? "w" : "r");
}

export function getOrCreateTextPipeline(
    engine: EngineContext,
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    depthStencilFormat: GPUTextureFormat | null,
    depthWrite: boolean
): { pipeline: GPURenderPipeline; cache: TextPipelineDeviceCache } {
    const cache = getOrCreateDeviceCache(engine);
    const key = pipelineKey(format, sampleCount, depthStencilFormat, depthWrite);
    let pipeline = cache.pipelines.get(key);
    if (pipeline) {
        return { pipeline, cache };
    }
    const device = engine._device;
    const descriptor: GPURenderPipelineDescriptor = {
        label: "text-pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [cache.bindGroupLayout] }),
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
                        { shaderLocation: 5, offset: 64, format: "float32x4" },
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
                        // Premultiplied-alpha blend. The Slug fragment shader outputs
                        // `vColor * coverage` — i.e. RGB already premultiplied by coverage
                        // (and alpha = coverage) — so the color blend must use srcFactor
                        // `one` (NOT `src-alpha`, which would multiply by coverage a second
                        // time and render anti-aliased edges as coverage², too dark). The
                        // alpha channel already uses `one` for the same reason.
                        color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                    },
                },
            ],
        },
        primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
        multisample: { count: sampleCount },
    };
    if (depthStencilFormat) {
        descriptor.depthStencil = {
            format: depthStencilFormat,
            depthCompare: "greater-equal",
            depthWriteEnabled: depthWrite,
        };
    }
    pipeline = device.createRenderPipeline(descriptor);
    cache.pipelines.set(key, pipeline);
    return { pipeline, cache };
}
