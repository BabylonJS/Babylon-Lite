/** Owns the text render pipeline + bind-group layouts. Lazy per-device cache.
 *
 *  This module knows nothing about shader fragments and composes no WGSL. An opt-in text
 *  styling feature composes and compiles its own module pair and installs a resolver here;
 *  everything this file does with it is "use these two modules instead of the base pair,
 *  and put its id in the cache key". */

import type { EngineContext } from "../../engine/engine.js";
import { composeSlugShader } from "../shaders/slug-shader.js";
import { TEXT_INSTANCE_BYTES } from "../text-data.js";
import { _getAlphaToCoverageResolver } from "../../render/alpha-to-coverage-hook.js";

/** @internal Opaque, already-compiled shader-module pair for one composed text shader
 *  variant. Produced and owned by the opt-in feature that composed it — this module never
 *  creates, caches or invalidates the modules, so a second feature can neither overwrite
 *  another's pair nor inherit a stale one. */
export interface TextPipelineVariant {
    /** @internal Stable id; the variant field of the pipeline cache key. */
    readonly _id: string;
    /** @internal */
    readonly _vertModule: GPUShaderModule;
    /** @internal */
    readonly _fragModule: GPUShaderModule;
}

/** @internal Resolves the installed styling feature's compiled module pair for a device.
 *  Null until an opt-in feature installs one, and while null no variant pipeline key is
 *  ever produced and no variant pipeline is ever created, so a base draw is unaffected.
 *  One styling feature at a time: installing a second replaces the first. */
export let _textVariantResolver: ((device: GPUDevice) => TextPipelineVariant) | null = null;

/** @internal Install the variant resolver. Called from inside an opt-in setter (never at
 *  module scope) so importing this module has no effect. */
export function _installTextVariantResolver(resolve: (device: GPUDevice) => TextPipelineVariant): void {
    _textVariantResolver = resolve;
}

/** @internal */
export interface TextPipelineDeviceCache {
    /** @internal */
    _bindGroupLayout: GPUBindGroupLayout;
    /** @internal */
    _vertModule: GPUShaderModule;
    /** @internal */
    _fragModule: GPUShaderModule;
    /** @internal */
    _quadVertexBuffer: GPUBuffer;
    /** @internal */
    _pipelines: Map<string, GPURenderPipeline>;
}

/** @internal Base + variant pipeline for one target signature. `_variantPipeline` aliases
 *  `_pipeline` when no styling feature is installed, so draw paths can bind it
 *  unconditionally without a null check. */
export interface TextPipelineSet {
    /** @internal */
    _pipeline: GPURenderPipeline;
    /** @internal */
    _variantPipeline: GPURenderPipeline;
    /** @internal */
    _cache: TextPipelineDeviceCache;
}

let _cache: WeakMap<GPUDevice, TextPipelineDeviceCache> | null = null;

/** Clear the text pipeline cache for a device, releasing cache-held refs. */
export function clearTextPipelineCache(engine: EngineContext): void {
    _cache?.delete(engine._device);
}

/** Shared 4-vertex unit quad: corner signs (-1,-1), (1,-1), (1,1), (-1,1). */
const QUAD_CORNERS = [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1] as const;

/**
 * Pipeline-constant ID of the `a2c` override in the Slug fragment shader, declared as `@id(0)`.
 *
 * Deliberately keyed by number, not by name: the shader is an opaque string to JS minifiers,
 * so an unquoted `{ a2c: 1 }` key would be property-mangled by Closure ADVANCED while the WGSL
 * text kept `a2c`, and A2C pipeline creation would fail in those builds. Numeric keys survive
 * mangling, and WebGPU requires the numeric key once `@id` is specified.
 */
const A2C_CONSTANT_ID = 0;

/** @internal Per-device bind group layout, base shader modules and shared quad buffer.
 *  Draw paths that only need the quad buffer or the bind-group layout call this directly
 *  rather than `getOrCreateTextPipeline`, which would build cache keys they never use. */
export function getTextPipelineCache(engine: EngineContext): TextPipelineDeviceCache {
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
            { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        ],
    });
    const base = composeSlugShader(null);
    const vertModule = device.createShaderModule({ label: "text-vert", code: base._vert });
    const fragModule = device.createShaderModule({ label: "text-frag", code: base._frag });
    const corners = new Float32Array(QUAD_CORNERS);
    const quadVertexBuffer = device.createBuffer({
        label: "text-quad-corners",
        size: corners.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
    });
    new Float32Array(quadVertexBuffer.getMappedRange()).set(corners);
    quadVertexBuffer.unmap();

    cache = {
        _bindGroupLayout: bindGroupLayout,
        _vertModule: vertModule,
        _fragModule: fragModule,
        _quadVertexBuffer: quadVertexBuffer,
        _pipelines: new Map(),
    };
    _cache.set(device, cache);
    return cache;
}

/** @internal Fixed-arity pipeline cache key: six `:`-separated fields, every one always
 *  present. There is no optional field and no delimiter alias, so a base alpha-to-coverage
 *  pipeline (`…:a:-`) can never produce the same string as a variant whose id is `"a"`
 *  (`…:-:a`). Exported for the collision regression test. */
export function _textPipelineKey(
    format: GPUTextureFormat,
    sampleCount: number,
    depthStencilFormat: GPUTextureFormat | null,
    depthWrite: boolean,
    alphaToCoverage: boolean,
    variantId: string
): string {
    return format + ":" + sampleCount + ":" + (depthStencilFormat ?? "-") + ":" + (depthWrite ? "w" : "r") + ":" + (alphaToCoverage ? "a" : "-") + ":" + variantId;
}

function buildPipeline(
    device: GPUDevice,
    cache: TextPipelineDeviceCache,
    format: GPUTextureFormat,
    sampleCount: number,
    depthStencilFormat: GPUTextureFormat | null,
    depthWrite: boolean,
    alphaToCoverage: boolean,
    variant: TextPipelineVariant | null
): GPURenderPipeline {
    const key = _textPipelineKey(format, sampleCount, depthStencilFormat, depthWrite, alphaToCoverage, variant ? variant._id : "-");
    let pipeline = cache._pipelines.get(key);
    if (pipeline) {
        return pipeline;
    }
    const descriptor: GPURenderPipelineDescriptor = {
        label: "text-pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [cache._bindGroupLayout] }),
        vertex: {
            module: variant ? variant._vertModule : cache._vertModule,
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
                        { shaderLocation: 1, offset: 0, format: "float32x2" },
                        { shaderLocation: 2, offset: 8, format: "uint32" },
                    ],
                },
            ],
        },
        fragment: {
            module: variant ? variant._fragModule : cache._fragModule,
            entryPoint: "main",
            // `a2c` is a pipeline-overridable constant in the Slug fragment; setting it switches the
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
    cache._pipelines.set(key, pipeline);
    return pipeline;
}

export function getOrCreateTextPipeline(
    engine: EngineContext,
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    depthStencilFormat: GPUTextureFormat | null,
    depthWrite: boolean,
    owner?: object
): TextPipelineSet {
    const cache = getTextPipelineCache(engine);
    const alphaToCoverageResolver = _getAlphaToCoverageResolver();
    const alphaToCoverage = depthWrite && sampleCount > 1 && !!owner && !!alphaToCoverageResolver?.(owner);
    const device = engine._device;
    const pipeline = buildPipeline(device, cache, format, sampleCount, depthStencilFormat, depthWrite, alphaToCoverage, null);
    // Resolved here — at bind/update time — so the draw loop never builds a cache key.
    let variantPipeline = pipeline;
    if (_textVariantResolver) {
        variantPipeline = buildPipeline(device, cache, format, sampleCount, depthStencilFormat, depthWrite, alphaToCoverage, _textVariantResolver(device));
    }
    return { _pipeline: pipeline, _variantPipeline: variantPipeline, _cache: cache };
}
