import type { ComputeBindingSet } from "./compute-bindings.js";
import { _createComputeDispatch, setComputeDispatchSize, type ComputeDirectDispatch, type ComputeDispatch } from "./compute-dispatch.js";
import type { ComputeShader } from "./compute-shader.js";
import { _assertComputeShaderLive, _getComputeGroupLayouts } from "./compute-shader.js";

/** Pipeline override values for one compute variant. */
export type ComputePipelineConstants = Readonly<Record<string, number>>;

/** Prepared override-constant variant of a compute shader. */
export interface ComputePipelineVariant {
    readonly shader: ComputeShader;
    readonly constants: ComputePipelineConstants;
    /** @internal */
    _device: GPUDevice | null;
    /** @internal */
    _pipeline: GPUComputePipeline | null;
    /** @internal */
    _pending: Promise<GPUComputePipeline> | null;
}

/** Options for a direct dispatch using a pipeline variant. */
export interface ComputeVariantDispatchOptions {
    readonly size: ComputeDirectDispatch;
    readonly enabled?: boolean;
}

function normalize(constants: ComputePipelineConstants): ComputePipelineConstants {
    const normalized: Record<string, number> = {};
    for (const [name, value] of Object.entries(constants).sort(([a], [b]) => a.localeCompare(b))) {
        const numericId = /^(?:0|[1-9]\d*)$/.test(name);
        if (!name || (numericId && Number(name) > 65535) || !Number.isFinite(value)) {
            throw new Error(`Compute pipeline override "${name}" must have a non-empty name or decimal @id from 0 to 65535 with a finite value.`);
        }
        normalized[name] = value;
    }
    return Object.freeze(normalized);
}

function refresh(variant: ComputePipelineVariant): void {
    _assertComputeShaderLive(variant.shader);
    if (variant._device !== variant.shader._engine._device) {
        throw new Error(`Compute pipeline variant for "${variant.shader.name}" belongs to a lost or replaced GPU device; recreate it.`);
    }
}

function descriptor(variant: ComputePipelineVariant): GPUComputePipelineDescriptor {
    const shader = variant.shader;
    _getComputeGroupLayouts(shader);
    const device = shader._engine._device;
    shader._module ??= device.createShaderModule({ label: `${shader.name}-module`, code: shader._source });
    return {
        label: shader.name,
        layout: shader._pipelineLayout!,
        compute: { module: shader._module, entryPoint: shader._entryPoint, constants: variant.constants },
    };
}

/** Create a reusable override-constant pipeline variant. */
export function createComputePipelineVariant(shader: ComputeShader, constants: ComputePipelineConstants): ComputePipelineVariant {
    _assertComputeShaderLive(shader);
    return { shader, constants: normalize(constants), _device: shader._engine._device, _pipeline: null, _pending: null };
}

/** @internal Resolve or synchronously build a variant pipeline. */
export function _getComputeVariantPipeline(variant: ComputePipelineVariant): GPUComputePipeline {
    refresh(variant);
    return (variant._pipeline ??= variant.shader._engine._device.createComputePipeline(descriptor(variant)));
}

/** Prepare an override-constant pipeline variant. */
export async function prepareComputePipelineVariant(variant: ComputePipelineVariant): Promise<void> {
    refresh(variant);
    if (variant._pipeline) {
        return;
    }
    const device = variant.shader._engine._device;
    let pending = variant._pending;
    if (!pending) {
        pending = device.createComputePipelineAsync(descriptor(variant));
        variant._pending = pending;
        pending.then(
            (pipeline) => {
                if (!variant.shader._destroyed && variant.shader._engine._device === device && variant._pending === pending) {
                    variant._pipeline = pipeline;
                }
                if (variant._pending === pending) {
                    variant._pending = null;
                }
            },
            () => {
                if (variant._pending === pending) {
                    variant._pending = null;
                }
            }
        );
    }
    try {
        await pending;
    } catch (error) {
        _assertComputeShaderLive(variant.shader);
        throw error;
    }
    refresh(variant);
    if (!variant._pipeline) {
        await prepareComputePipelineVariant(variant);
    }
}

/** Create a direct dispatch that opts into one pipeline variant. */
export function createComputeVariantDispatch(variant: ComputePipelineVariant, bindings: ComputeBindingSet, options: ComputeVariantDispatchOptions): ComputeDispatch {
    const dispatch = _createComputeDispatch(variant.shader, bindings, options.enabled);
    setComputeDispatchSize(dispatch, options.size);
    dispatch._getPipeline = () => _getComputeVariantPipeline(variant);
    dispatch._preparePipeline = () => prepareComputePipelineVariant(variant);
    return dispatch;
}
