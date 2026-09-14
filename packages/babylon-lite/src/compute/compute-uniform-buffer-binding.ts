import type { EngineContext } from "../engine/engine.js";
import type { UniformBuffer } from "../resource/uniform-buffer.js";
import { _hasUniformBuffer } from "../resource/uniform-buffer.js";
import { _createComputeBindingDecl, _installComputeBindingResolver, type ComputeBindingDecl } from "./compute-binding.js";
import { _getComputeBufferBindingResource, _resolveComputeBufferBinding, type ComputeBufferRange, type ComputeBufferResource } from "./compute-buffer-binding.js";

const UNIFORM_BUFFER_KIND = 2;

/** Options for a compute uniform-buffer declaration. */
export interface ComputeUniformBufferBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly dynamicOffset?: boolean;
    readonly minBindingSize?: number;
}

/** Optional static range of a uniform allocation. */
export type ComputeUniformBufferRange = ComputeBufferRange<UniformBuffer>;

interface UniformBindingData {
    readonly dynamic: boolean;
    readonly minSize: number;
}

function isUniformBuffer(value: ComputeBufferResource): value is UniformBuffer {
    return !("_usage" in value);
}

function resolveUniformBuffer(engine: EngineContext, decl: ComputeBindingDecl, resource: unknown) {
    const data = decl._data as UniformBindingData;
    const alignment = Number(engine._device.limits.minUniformBufferOffsetAlignment) || 1;
    const maxBindingSize = Number(engine._device.limits.maxUniformBufferBindingSize) || Number.MAX_SAFE_INTEGER;
    return _resolveComputeBufferBinding(engine, decl, resource, isUniformBuffer, () => true, false, data.dynamic, data.minSize, maxBindingSize, alignment);
}

function getUniformBuffer(engine: EngineContext, state: unknown): GPUBindingResource {
    return _getComputeBufferBindingResource(engine, state, (owner, buffer) => _hasUniformBuffer(owner, buffer as UniformBuffer));
}

/** Declare a uniform-buffer binding and opt the shader into uniform-buffer support. */
export function computeUniformBufferBinding(name: string, options: ComputeUniformBufferBindingOptions): ComputeBindingDecl {
    _installComputeBindingResolver(UNIFORM_BUFFER_KIND, resolveUniformBuffer, getUniformBuffer);
    return _createComputeBindingDecl(
        name,
        options.group,
        options.binding,
        UNIFORM_BUFFER_KIND,
        {
            buffer: {
                type: "uniform",
                hasDynamicOffset: options.dynamicOffset === true,
                ...(options.minBindingSize !== undefined ? { minBindingSize: options.minBindingSize } : {}),
            },
        },
        { dynamic: options.dynamicOffset === true, minSize: options.minBindingSize ?? 0 } satisfies UniformBindingData
    );
}
