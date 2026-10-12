import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget, RenderTargetSignature } from "../engine/render-target.js";
import { REVERSE_DEPTH_COMPARE } from "../engine/render-target.js";
import { targetSignatureKey } from "../engine/render-target-signature.js";
import type { ComputeBindingDecl } from "../compute/compute-binding.js";
import type { ComputeBindingResources, ComputeBindingSet } from "../compute/compute-bindings.js";
import { createComputeBindingSet, disposeComputeBindingSet } from "../compute/compute-bindings.js";
import type { ComputeShader } from "../compute/compute-shader.js";
import { _assertComputeShaderLive, createComputeShader, disposeComputeShader } from "../compute/compute-shader.js";

/** Per-color-target state of a {@link RenderShader}. The format comes from the render target at draw time. */
export interface RenderShaderTargetOptions {
    readonly blend?: GPUBlendState;
    readonly writeMask?: GPUColorWriteFlags;
}

/** Depth state of a {@link RenderShader}. The depth format comes from the render target at draw time. */
export interface RenderShaderDepthOptions {
    readonly depthWriteEnabled?: boolean;
    /** Defaults to Lite's reverse-Z `"greater-equal"`. */
    readonly depthCompare?: GPUCompareFunction;
}

/** Options for {@link createRenderShader}. The source contains complete WGSL declarations and both entry points. */
export interface RenderShaderOptions {
    readonly name?: string;
    readonly renderSource: string;
    readonly vertexEntryPoint?: string;
    readonly fragmentEntryPoint?: string;
    /**
     * Resource declarations, created with the same helpers as compute (`computeUniformBufferBinding`,
     * `computeStorageBufferBinding`, `computeTextureBinding`, `computeSamplerBinding`, ...).
     * Read-only resources are visible to both stages; writable storage is fragment-only, as WebGPU requires.
     */
    readonly bindings?: readonly ComputeBindingDecl[];
    /** Vertex-buffer layouts. Each draw supplies one `StorageBuffer` created with `vertex: true` per layout. */
    readonly vertexBuffers?: readonly GPUVertexBufferLayout[];
    readonly primitive?: GPUPrimitiveState;
    /** Color-target state; one entry for the single color attachment of a render target. */
    readonly target?: RenderShaderTargetOptions;
    readonly depth?: RenderShaderDepthOptions;
}

declare const renderShaderBrand: unique symbol;

/** Immutable render program: WGSL, binding layout and fixed-function state, compiled per render-target format. */
export interface RenderShader {
    readonly [renderShaderBrand]: true;
    readonly name: string;
    /** @internal Shared binding core: declaration validation, layouts and binding sets. */
    readonly _program: ComputeShader;
    /** @internal */
    readonly _options: RenderShaderOptions;
    /** @internal */
    _module: GPUShaderModule | null;
    /** @internal Pipelines by render-target signature key. */
    _pipelines: Map<string, GPURenderPipeline> | null;
    /** @internal In-flight compilations by render-target signature key. */
    _pending: Map<string, Promise<GPURenderPipeline>> | null;
    /** @internal Allocation-free per-target lookup in front of `_pipelines`. */
    _byTarget: WeakMap<RenderTarget, RenderTargetSignature & { readonly pipeline: GPURenderPipeline }> | null;
}

declare const renderBindingSetBrand: unique symbol;

/** Immutable reusable resources for one render program. */
export interface RenderBindingSet {
    readonly [renderBindingSetBrand]: true;
    readonly shader: RenderShader;
    /** @internal */
    readonly _set: ComputeBindingSet;
}

function renderVisibility(decl: ComputeBindingDecl): GPUShaderStageFlags {
    const layout = decl._layout;
    const writableBuffer = layout.buffer?.type === "storage";
    const writableTexture = layout.storageTexture !== undefined && layout.storageTexture.access !== "read-only";
    return writableBuffer || writableTexture ? SS.FRAGMENT : SS.VERTEX | SS.FRAGMENT;
}

/** Create an immutable render program. Bind-group layouts are created now; pipelines are created per target format. */
export function createRenderShader(engine: EngineContext, options: RenderShaderOptions): RenderShader {
    if (!options.renderSource) {
        throw new Error("RenderShader: renderSource must not be empty.");
    }
    const name = options.name ?? "render";
    // The compute factory validates declarations against the device limits and builds the slot tables
    // binding sets rely on. Render layouts differ only in stage visibility, so they are installed here.
    const program = createComputeShader(engine, { name, computeSource: options.renderSource, bindings: options.bindings });
    const device = engine._device;
    const highestGroup = program._decls.at(-1)?.group ?? -1;
    const layouts: GPUBindGroupLayout[] = [];
    for (let group = 0; group <= highestGroup; group++) {
        const entries: GPUBindGroupLayoutEntry[] = [];
        for (const decl of program._decls) {
            if (decl.group === group) {
                entries.push({ binding: decl.binding, visibility: renderVisibility(decl), ...decl._layout });
            }
        }
        layouts.push(device.createBindGroupLayout({ label: `${name}-group${group}`, entries }));
    }
    program._layouts = layouts;
    program._pipelineLayout = device.createPipelineLayout({ label: `${name}-layout`, bindGroupLayouts: layouts });
    return {
        name,
        _program: program,
        _options: options,
        _module: null,
        _pipelines: null,
        _pending: null,
        _byTarget: null,
    } as unknown as RenderShader;
}

/** @internal Reject use after disposal or device replacement. */
export function _assertRenderShaderLive(shader: RenderShader): void {
    _assertComputeShaderLive(shader._program);
}

function pipelineDepthCompare(shader: RenderShader, target: RenderTarget): GPUCompareFunction | undefined {
    const descriptor = target._descriptor;
    return descriptor.dFormat && descriptor.dFormat !== "stencil8" ? (shader._options.depth?.depthCompare ?? descriptor.depthCompare ?? REVERSE_DEPTH_COMPARE) : undefined;
}

function pipelineKey(shader: RenderShader, target: RenderTarget): string {
    const descriptor = target._descriptor;
    return targetSignatureKey({
        _colorFormat: descriptor.format,
        _depthStencilFormat: descriptor.dFormat,
        _depthCompare: pipelineDepthCompare(shader, target),
        _sampleCount: descriptor.samples,
    });
}

function pipelineDescriptor(shader: RenderShader, target: RenderTarget): GPURenderPipelineDescriptor {
    const program = shader._program;
    const options = shader._options;
    const device = program._engine._device;
    const module = (shader._module ??= device.createShaderModule({ label: `${shader.name}-module`, code: options.renderSource }));
    const descriptor = target._descriptor;
    const color = descriptor.format;
    const depth = descriptor.dFormat;
    return {
        label: `${shader.name}-${pipelineKey(shader, target)}`,
        layout: program._pipelineLayout!,
        vertex: { module, entryPoint: options.vertexEntryPoint ?? "vertexMain", buffers: options.vertexBuffers ? [...options.vertexBuffers] : [] },
        fragment: {
            module,
            entryPoint: options.fragmentEntryPoint ?? "fragmentMain",
            targets: color ? [{ format: color, blend: options.target?.blend, writeMask: options.target?.writeMask }] : [],
        },
        primitive: options.primitive ?? { topology: "triangle-list" },
        depthStencil: depth
            ? {
                  format: depth,
                  ...(depth !== "stencil8"
                      ? {
                            depthWriteEnabled: options.depth?.depthWriteEnabled ?? false,
                            depthCompare: pipelineDepthCompare(shader, target),
                        }
                      : {}),
              }
            : undefined,
        multisample: { count: descriptor.samples },
    };
}

/** @internal Resolve the pipeline for `target`, compiling it synchronously on first use. Allocation-free once cached. */
export function _getRenderPipeline(shader: RenderShader, target: RenderTarget): GPURenderPipeline {
    _assertRenderShaderLive(shader);
    const descriptor = target._descriptor;
    const depthCompare = pipelineDepthCompare(shader, target);
    const byTarget = (shader._byTarget ??= new WeakMap());
    const hit = byTarget.get(target);
    if (
        hit &&
        hit._colorFormat === descriptor.format &&
        hit._depthStencilFormat === descriptor.dFormat &&
        hit._depthCompare === depthCompare &&
        hit._sampleCount === descriptor.samples
    ) {
        return hit.pipeline;
    }
    const pipelines = (shader._pipelines ??= new Map());
    const key = pipelineKey(shader, target);
    let pipeline = pipelines.get(key);
    if (!pipeline) {
        pipeline = shader._program._engine._device.createRenderPipeline(pipelineDescriptor(shader, target));
        pipelines.set(key, pipeline);
    }
    byTarget.set(target, {
        pipeline,
        _colorFormat: descriptor.format,
        _depthStencilFormat: descriptor.dFormat,
        _depthCompare: depthCompare,
        _sampleCount: descriptor.samples,
    });
    return pipeline;
}

/** Compile the pipeline for `target` outside the frame loop, so the first frame that draws into it does not stall. */
export async function prepareRenderShader(shader: RenderShader, target: RenderTarget): Promise<void> {
    _assertRenderShaderLive(shader);
    const pipelines = (shader._pipelines ??= new Map());
    const key = pipelineKey(shader, target);
    if (pipelines.has(key)) {
        return;
    }
    const device = shader._program._engine._device;
    const pending = (shader._pending ??= new Map());
    let promise = pending.get(key);
    if (!promise) {
        promise = device.createRenderPipelineAsync(pipelineDescriptor(shader, target));
        pending.set(key, promise);
        void promise.then(
            (pipeline: GPURenderPipeline) => {
                if (!shader._program._destroyed && shader._program._engine._device === device && shader._pipelines === pipelines && !pipelines.has(key)) {
                    pipelines.set(key, pipeline);
                }
                if (pending.get(key) === promise) {
                    pending.delete(key);
                }
            },
            () => {
                if (pending.get(key) === promise) {
                    pending.delete(key);
                }
            }
        );
    }
    try {
        await promise;
    } catch (error) {
        _assertRenderShaderLive(shader);
        throw error;
    }
    _assertRenderShaderLive(shader);
}

/** Dispose program caches. Binding sets, draws and resources remain caller-owned. */
export function disposeRenderShader(shader: RenderShader): void {
    disposeComputeShader(shader._program);
    shader._module = null;
    shader._pipelines = null;
    shader._pending = null;
    shader._byTarget = null;
}

/** Create an immutable, prevalidated resource combination for a render program. */
export function createRenderBindingSet(shader: RenderShader, resources: ComputeBindingResources): RenderBindingSet {
    _assertRenderShaderLive(shader);
    return { shader, _set: createComputeBindingSet(shader._program, resources) } as unknown as RenderBindingSet;
}

/** Dispose device-relative bind groups. Bound resources remain caller-owned. */
export function disposeRenderBindingSet(bindings: RenderBindingSet): void {
    disposeComputeBindingSet(bindings._set);
}
