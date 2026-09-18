import type { EngineContext } from "../engine/engine.js";
import type { StorageBuffer } from "../resource/storage-buffer.js";
import { _createComputeBindingDecl, _installComputeBindingResolver, type ComputeBindingDecl } from "./compute-binding.js";
import { _getComputeBufferBindingResource, _resolveComputeBufferBinding, type ComputeBufferRange, type ComputeBufferResource } from "./compute-buffer-binding.js";

const STORAGE_BUFFER_KIND = 1;

/** Options for a compute storage-buffer declaration. */
export interface ComputeStorageBufferBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly access?: "read" | "read-write";
    readonly dynamicOffset?: boolean;
    readonly minBindingSize?: number;
}

/** Optional static range of a storage allocation. */
export type ComputeStorageBufferRange = ComputeBufferRange<StorageBuffer>;

interface StorageBindingData {
    readonly access: "read" | "read-write";
    readonly dynamic: boolean;
    readonly minSize: number;
}

function isStorageBuffer(value: ComputeBufferResource): value is StorageBuffer {
    return "_usage" in value;
}

function resolveStorageBuffer(engine: EngineContext, decl: ComputeBindingDecl, resource: unknown) {
    const data = decl._data as StorageBindingData;
    const alignment = Number(engine._device.limits.minStorageBufferOffsetAlignment) || 1;
    const maxBindingSize = Number(engine._device.limits.maxStorageBufferBindingSize) || Number.MAX_SAFE_INTEGER;
    return _resolveComputeBufferBinding(
        engine,
        decl,
        resource,
        isStorageBuffer,
        (value) => (value as StorageBuffer)._writable === true,
        data.access === "read-write",
        data.dynamic,
        data.minSize,
        maxBindingSize,
        alignment
    );
}

function getStorageBuffer(engine: EngineContext, state: unknown): GPUBindingResource {
    return _getComputeBufferBindingResource(engine, state, (owner, buffer) => owner._storageBuffers?.has(buffer as StorageBuffer) === true);
}

/** Declare a storage-buffer binding and opt the shader into storage-buffer support. */
export function computeStorageBufferBinding(name: string, options: ComputeStorageBufferBindingOptions): ComputeBindingDecl {
    _installComputeBindingResolver(STORAGE_BUFFER_KIND, resolveStorageBuffer, getStorageBuffer);
    const access = options.access ?? "read";
    if (access !== "read" && access !== "read-write") {
        throw new Error(`computeStorageBufferBinding: access must be "read" or "read-write", received "${String(access)}".`);
    }
    return _createComputeBindingDecl(
        name,
        options.group,
        options.binding,
        STORAGE_BUFFER_KIND,
        {
            buffer: {
                type: access === "read-write" ? "storage" : "read-only-storage",
                hasDynamicOffset: options.dynamicOffset === true,
                ...(options.minBindingSize !== undefined ? { minBindingSize: options.minBindingSize } : {}),
            },
        },
        { access, dynamic: options.dynamicOffset === true, minSize: options.minBindingSize ?? 0 } satisfies StorageBindingData
    );
}
