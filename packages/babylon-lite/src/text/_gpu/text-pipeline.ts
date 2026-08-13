/** Owns the text render pipeline + bind-group layouts. Lazy per-device cache. */

import type { EngineContext } from "../../engine/engine.js";
import vertSrc from "../shaders/slug.vert.wgsl?raw";
import fragSrc from "../shaders/slug.frag.wgsl?raw";
import { TEXT_INSTANCE_BYTES } from "../text-data.js";
import { _getAlphaToCoverageResolver } from "../../render/alpha-to-coverage-hook.js";

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

/**
 * Pipeline-constant ID of the `a2c` override in slug.frag.wgsl, declared there as `@id(0)`.
 *
 * Deliberately keyed by number, not by name: the shader is an opaque string to JS minifiers,
 * so an unquoted `{ a2c: 1 }` key would be property-mangled by Closure ADVANCED while the WGSL
 * text kept `a2c`, and A2C pipeline creation would fail in those builds. Numeric keys survive
 * mangling, and WebGPU requires the numeric key once `@id` is specified.
 */
const A2C_CONSTANT_ID = 0;

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

function pipelineKey(format: GPUTextureFormat, sampleCount: number, depthStencilFormat: GPUTextureFormat | null, depthWrite: boolean, alphaToCoverage: boolean): string {
    return format + ":" + sampleCount + ":" + (depthStencilFormat ?? "-") + ":" + (depthWrite ? "w" : "r") + (alphaToCoverage ? ":a" : "");
}

export function getOrCreateTextPipeline(
    engine: EngineContext,
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    depthStencilFormat: GPUTextureFormat | null,
    depthWrite: boolean,
    owner?: object
): { pipeline: GPURenderPipeline; cache: TextPipelineDeviceCache } {
    const cache = getOrCreateDeviceCache(engine);
    const alphaToCoverageResolver = _getAlphaToCoverageResolver();
    const alphaToCoverage = depthWrite && sampleCount > 1 && !!owner && !!alphaToCoverageResolver?.(owner);
    const key = pipelineKey(format, sampleCount, depthStencilFormat, depthWrite, alphaToCoverage);
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
            // `a2c` is a pipeline-overridable constant in slug.frag.wgsl; setting it switches the
            // fragment to straight-alpha output. Specialising one module beats shipping a second
            // near-identical shader, whose text every consumer would pay for even unused.
            ...(alphaToCoverage ? { constants: { [A2C_CONSTANT_ID]: 1 } } : {}),
            targets: [
                {
                    format,
                    ...(alphaToCoverage
                        ? {}
                        : {
                              // Premultiplied-alpha blend. The ordinary Slug fragment outputs
                              // `vColor * coverage`, so RGB is already coverage-weighted.
                              blend: {
                                  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } as GPUBlendComponent,
                                  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } as GPUBlendComponent,
                              },
                          }),
                },
            ],
        },
        primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
        multisample: alphaToCoverage ? { count: sampleCount, alphaToCoverageEnabled: true } : { count: sampleCount },
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
