import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { ComputeBindingDecl } from "./compute-binding.js";
/** Options for {@link createComputeShader}. The source contains complete WGSL declarations. */
export interface ComputeShaderOptions {
    readonly name?: string;
    readonly computeSource: string;
    readonly entryPoint?: string;
    readonly bindings?: readonly ComputeBindingDecl[];
}

/** @internal Pre-resolved declaration lookup. */
export interface ComputeBindingSlot {
    /** @internal */
    readonly _decl: ComputeBindingDecl;
    /** @internal Index among the dynamic buffer bindings in this group, or -1. */
    readonly _dynamicIndex: number;
}

declare const computeShaderBrand: unique symbol;

/** Immutable compute program and its device-relative pipeline variants. */
export interface ComputeShader {
    readonly [computeShaderBrand]: true;
    readonly name: string;
    /** @internal */
    readonly _engine: EngineContext;
    /** @internal */
    readonly _source: string;
    /** @internal */
    readonly _entryPoint: string;
    /** @internal */
    readonly _decls: readonly ComputeBindingDecl[];
    /** @internal */
    readonly _slots: Map<string, ComputeBindingSlot>;
    /** @internal Dynamic binding count per group. */
    readonly _dynamicCounts: readonly number[];
    /** @internal Immediate-data capacity installed only by the opt-in immediate shader factory. */
    _immediateByteLength?: number;
    /** @internal */
    _device: GPUDevice | null;
    /** @internal */
    _module: GPUShaderModule | null;
    /** @internal */
    _layouts: GPUBindGroupLayout[] | null;
    /** @internal */
    _pipelineLayout: GPUPipelineLayout | null;
    /** @internal Default pipeline without override constants. */
    _pipeline: GPUComputePipeline | null;
    /** @internal Async default-pipeline creation in flight. */
    _pending: Promise<GPUComputePipeline> | null;
    /** @internal */
    _destroyed: boolean;
}

type ComputePipelineLayoutDescriptorExtension = (shader: ComputeShader) => Pick<GPUPipelineLayoutDescriptor, "immediateSize"> | undefined;
let _pipelineLayoutDescriptorExtension: ComputePipelineLayoutDescriptorExtension | null = null;

/** @internal Install optional compute pipeline-layout fields. */
export function _installComputePipelineLayoutDescriptorExtension(extension: ComputePipelineLayoutDescriptorExtension): void {
    _pipelineLayoutDescriptorExtension = extension;
}

function assertName(kind: string, name: string): void {
    if (!name) {
        throw new Error(`ComputeShader: ${kind} must not be empty.`);
    }
}

function validateIndex(kind: string, value: number): void {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`ComputeShader: ${kind} must be a non-negative integer, received ${value}.`);
    }
}

/** Create an immutable compute program descriptor. */
export function createComputeShader(engine: EngineContext, options: ComputeShaderOptions): ComputeShader {
    const entryPoint = options.entryPoint ?? "main";
    assertName("entry point", entryPoint);
    if (!options.computeSource) {
        throw new Error("ComputeShader: computeSource must not be empty.");
    }

    const decls = [...(options.bindings ?? [])].sort((a, b) => a.group - b.group || a.binding - b.binding);
    const slots = new Map<string, ComputeBindingSlot>();
    const pairs = new Set<string>();
    const dynamicCounts: number[] = [];
    const maxGroups = Number(engine._device.limits.maxBindGroups) || Number.MAX_SAFE_INTEGER;
    const maxBindings = Number(engine._device.limits.maxBindingsPerBindGroup) || Number.MAX_SAFE_INTEGER;
    let uniformBuffers = 0;
    let storageBuffers = 0;
    let dynamicUniformBuffers = 0;
    let dynamicStorageBuffers = 0;
    let sampledTextures = 0;
    let samplers = 0;
    let storageTextures = 0;
    for (const decl of decls) {
        assertName("binding name", decl.name);
        validateIndex(`group for "${decl.name}"`, decl.group);
        validateIndex(`binding for "${decl.name}"`, decl.binding);
        if (decl.group >= maxGroups) {
            throw new Error(`ComputeShader: group ${decl.group} exceeds this device's maxBindGroups (${maxGroups}).`);
        }
        if (decl.binding >= maxBindings) {
            throw new Error(`ComputeShader: binding ${decl.binding} exceeds this device's maxBindingsPerBindGroup (${maxBindings}).`);
        }
        if (slots.has(decl.name)) {
            throw new Error(`ComputeShader: binding name "${decl.name}" is declared more than once.`);
        }
        const pair = `${decl.group}:${decl.binding}`;
        if (pairs.has(pair)) {
            throw new Error(`ComputeShader: group ${decl.group} binding ${decl.binding} is declared more than once.`);
        }
        pairs.add(pair);
        const minBindingSize = decl._layout.buffer?.minBindingSize;
        if (minBindingSize !== undefined) {
            const size = Number(minBindingSize);
            if (!Number.isInteger(size) || size < 0 || (size & 3) !== 0) {
                throw new Error(`ComputeShader: minBindingSize for "${decl.name}" must be a non-negative multiple of 4.`);
            }
        }
        const bufferLayout = decl._layout.buffer;
        if (bufferLayout) {
            if (bufferLayout.type === "uniform") {
                uniformBuffers++;
                if (bufferLayout.hasDynamicOffset) {
                    dynamicUniformBuffers++;
                }
            } else {
                storageBuffers++;
                if (bufferLayout.hasDynamicOffset) {
                    dynamicStorageBuffers++;
                }
            }
        }
        if (decl._layout.texture) {
            sampledTextures++;
        }
        if (decl._layout.sampler) {
            samplers++;
        }
        if (decl._layout.storageTexture) {
            storageTextures++;
        }
        let dynamicIndex = -1;
        if (decl._layout.buffer?.hasDynamicOffset) {
            dynamicIndex = dynamicCounts[decl.group] ?? 0;
            dynamicCounts[decl.group] = dynamicIndex + 1;
        }
        slots.set(decl.name, { _decl: decl, _dynamicIndex: dynamicIndex });
    }
    const limits = engine._device.limits;
    const assertCount = (name: string, count: number, maximum: number | undefined): void => {
        if (maximum !== undefined && count > maximum) {
            throw new Error(`ComputeShader: ${count} ${name} exceed this device's limit of ${maximum}.`);
        }
    };
    assertCount("uniform buffers", uniformBuffers, limits.maxUniformBuffersPerShaderStage);
    assertCount("storage buffers", storageBuffers, limits.maxStorageBuffersPerShaderStage);
    assertCount("dynamic uniform buffers", dynamicUniformBuffers, limits.maxDynamicUniformBuffersPerPipelineLayout);
    assertCount("dynamic storage buffers", dynamicStorageBuffers, limits.maxDynamicStorageBuffersPerPipelineLayout);
    assertCount("sampled textures", sampledTextures, limits.maxSampledTexturesPerShaderStage);
    assertCount("samplers", samplers, limits.maxSamplersPerShaderStage);
    assertCount("storage textures", storageTextures, limits.maxStorageTexturesPerShaderStage);
    const groupCount = (decls.at(-1)?.group ?? -1) + 1;
    for (let group = 0; group < groupCount; group++) {
        dynamicCounts[group] ??= 0;
    }

    return {
        name: options.name ?? "compute",
        _engine: engine,
        _source: options.computeSource,
        _entryPoint: entryPoint,
        _decls: decls,
        _slots: slots,
        _dynamicCounts: dynamicCounts,
        _device: engine._device,
        _module: null,
        _layouts: null,
        _pipelineLayout: null,
        _pipeline: null,
        _pending: null,
        _destroyed: false,
    } as unknown as ComputeShader;
}

/** @internal Reject use after disposal. */
export function _assertComputeShaderLive(shader: ComputeShader): void {
    if (shader._destroyed) {
        throw new Error(`ComputeShader "${shader.name}" has been disposed.`);
    }
    if (shader._device !== shader._engine._device) {
        throw new Error(`ComputeShader "${shader.name}" belongs to a lost or replaced GPU device; recreate the compute graph.`);
    }
}

function layoutEntry(decl: ComputeBindingDecl): GPUBindGroupLayoutEntry {
    return { binding: decl.binding, visibility: SS.COMPUTE, ...decl._layout };
}

/** @internal Resolve current-device bind-group layouts, including empty gap groups. */
export function _getComputeGroupLayouts(shader: ComputeShader): readonly GPUBindGroupLayout[] {
    _assertComputeShaderLive(shader);
    if (shader._layouts) {
        return shader._layouts;
    }
    const highestGroup = shader._decls.at(-1)?.group ?? -1;
    const layouts: GPUBindGroupLayout[] = [];
    for (let group = 0; group <= highestGroup; group++) {
        const entries = shader._decls.filter((decl) => decl.group === group).map(layoutEntry);
        layouts.push(shader._engine._device.createBindGroupLayout({ label: `${shader.name}-group${group}`, entries }));
    }
    shader._layouts = layouts;
    shader._pipelineLayout = shader._engine._device.createPipelineLayout({
        label: `${shader.name}-layout`,
        bindGroupLayouts: layouts,
        ..._pipelineLayoutDescriptorExtension?.(shader),
    });
    return layouts;
}

function pipelineDescriptor(shader: ComputeShader): GPUComputePipelineDescriptor {
    _getComputeGroupLayouts(shader);
    const device = shader._engine._device;
    shader._module ??= device.createShaderModule({ label: `${shader.name}-module`, code: shader._source });
    return {
        label: shader.name,
        layout: shader._pipelineLayout!,
        compute: {
            module: shader._module,
            entryPoint: shader._entryPoint,
        },
    };
}

/** @internal Resolve the prepared default pipeline or synchronously create it on first use. */
export function _getComputePipeline(shader: ComputeShader): GPUComputePipeline {
    _assertComputeShaderLive(shader);
    return (shader._pipeline ??= shader._engine._device.createComputePipeline(pipelineDescriptor(shader)));
}

/** Compile the default pipeline outside the frame loop. */
export async function prepareComputeShader(shader: ComputeShader): Promise<void> {
    _assertComputeShaderLive(shader);
    if (shader._pipeline) {
        return;
    }
    const device = shader._engine._device;
    let promise = shader._pending;
    if (!promise) {
        promise = device.createComputePipelineAsync(pipelineDescriptor(shader));
        shader._pending = promise;
        promise.then(
            (pipeline: GPUComputePipeline) => {
                if (!shader._destroyed && shader._engine._device === device) {
                    shader._pipeline = pipeline;
                }
                if (shader._pending === promise) {
                    shader._pending = null;
                }
            },
            () => {
                if (shader._pending === promise) {
                    shader._pending = null;
                }
            }
        );
    }
    try {
        await promise;
    } catch (error) {
        _assertComputeShaderLive(shader);
        throw error;
    }
    _assertComputeShaderLive(shader);
    if (!shader._pipeline) {
        throw new Error(`ComputeShader "${shader.name}" pipeline preparation did not complete on its owning device.`);
    }
}

/** Dispose program caches. Binding sets and resources remain caller-owned. */
export function disposeComputeShader(shader: ComputeShader): void {
    if (shader._destroyed) {
        return;
    }
    shader._destroyed = true;
    shader._module = null;
    shader._layouts = null;
    shader._pipelineLayout = null;
    shader._pipeline = null;
    shader._pending = null;
    shader._device = null;
}
