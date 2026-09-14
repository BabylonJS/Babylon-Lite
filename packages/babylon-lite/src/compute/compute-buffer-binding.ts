import type { EngineContext } from "../engine/engine.js";
import type { ComputeBindingDecl, ComputeResolvedBinding } from "./compute-binding.js";

/** Static range inside a compute buffer binding. */
export interface ComputeBufferRange<T> {
    readonly buffer: T;
    readonly offset?: number;
    readonly size?: number;
}

/** @internal Common shape shared by opaque uniform and storage buffer wrappers. */
export interface ComputeBufferResource {
    readonly byteLength: number;
    /** @internal */
    _buffer: GPUBuffer | null;
    /** @internal */
    _destroyed: boolean;
    /** @internal */
    readonly _engine: EngineContext;
}

/** @internal Resource-specific buffer declaration state. */
export interface ComputeBufferBindingState {
    /** @internal */
    readonly _buffer: ComputeBufferResource;
    /** @internal */
    readonly _offset: number;
    /** @internal */
    readonly _size?: number;
}

/** @internal Validate and normalize one buffer binding without importing either resource module. */
export function _resolveComputeBufferBinding(
    engine: EngineContext,
    decl: ComputeBindingDecl,
    input: unknown,
    isExpected: (value: ComputeBufferResource) => boolean,
    isWritable: (value: ComputeBufferResource) => boolean,
    writable: boolean,
    dynamic: boolean,
    minBindingSize: number,
    maxBindingSize: number,
    alignment: number
): ComputeResolvedBinding {
    const range =
        typeof input === "object" && input !== null && "buffer" in input ? (input as ComputeBufferRange<ComputeBufferResource>) : { buffer: input as ComputeBufferResource };
    const buffer = range.buffer;
    if (!buffer || typeof buffer !== "object" || !isExpected(buffer)) {
        throw new Error(`ComputeBindingSet: binding "${decl.name}" received the wrong buffer resource type.`);
    }
    if (buffer._destroyed || !buffer._buffer) {
        throw new Error(`ComputeBindingSet: resource for "${decl.name}" has been disposed.`);
    }
    if (buffer._engine !== engine) {
        throw new Error(`ComputeBindingSet: resource for "${decl.name}" belongs to a different engine.`);
    }
    if (writable && !isWritable(buffer)) {
        throw new Error(`ComputeBindingSet: writable binding "${decl.name}" received a read-only resource.`);
    }
    const offset = range.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset % alignment !== 0) {
        throw new Error(`ComputeBindingSet: offset for "${decl.name}" must be a non-negative multiple of ${alignment}.`);
    }
    let size = range.size;
    if (size === undefined && dynamic) {
        size = minBindingSize || undefined;
        if (!size) {
            throw new Error(`ComputeBindingSet: dynamic binding "${decl.name}" requires size or a non-zero minBindingSize.`);
        }
    }
    if (size !== undefined && (!Number.isInteger(size) || size <= 0 || (size & 3) !== 0)) {
        throw new Error(`ComputeBindingSet: size for "${decl.name}" must be a positive multiple of 4.`);
    }
    const boundSize = size ?? buffer.byteLength - offset;
    if (boundSize <= 0) {
        throw new Error(`ComputeBindingSet: binding "${decl.name}" must expose at least 4 bytes.`);
    }
    if (boundSize < minBindingSize) {
        throw new Error(`ComputeBindingSet: binding "${decl.name}" provides ${boundSize} bytes but requires at least ${minBindingSize} bytes.`);
    }
    if (boundSize > maxBindingSize) {
        throw new Error(`ComputeBindingSet: binding "${decl.name}" exceeds this device's maximum binding size of ${maxBindingSize} bytes.`);
    }
    if (offset + boundSize > buffer.byteLength) {
        throw new Error(`ComputeBindingSet: binding "${decl.name}" exceeds its ${buffer.byteLength}-byte allocation.`);
    }
    return {
        _state: { _buffer: buffer, _offset: offset, _size: size } satisfies ComputeBufferBindingState,
        ...(dynamic ? { _dynamic: { _alignment: alignment, _maxOffset: buffer.byteLength - offset - boundSize } } : {}),
    };
}

/** @internal Resolve the current GPU handle after validating the resource remains registered. */
export function _getComputeBufferBindingResource(
    engine: EngineContext,
    state: unknown,
    isRegistered: (engine: EngineContext, buffer: ComputeBufferResource) => boolean
): GPUBufferBinding {
    const binding = state as ComputeBufferBindingState;
    const buffer = binding._buffer;
    if (buffer._destroyed || !buffer._buffer || buffer._engine !== engine || !isRegistered(engine, buffer)) {
        throw new Error("ComputeBindingSet contains a disposed or invalid buffer resource.");
    }
    return {
        buffer: buffer._buffer,
        offset: binding._offset,
        ...(binding._size !== undefined ? { size: binding._size } : {}),
    };
}
