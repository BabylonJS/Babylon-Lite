import type { GLEngineContext } from "./context.js";
import type { GLEffect } from "./effect.js";
import type { NativeHandle } from "./runtime.js";

/** Owned immutable float vertex storage. */
export interface GLVertexBuffer {
    readonly byteLength: number;
    /** @internal */
    readonly _handle: NativeHandle;
    /** @internal */
    readonly _index: false;
    /** @internal The engine that owns this buffer. */
    readonly _engine: GLEngineContext;
    /** @internal */
    _disposed: boolean;
}

/** Owned immutable index storage. */
export interface GLIndexBuffer {
    readonly count: number;
    /** @internal */
    readonly _handle: NativeHandle;
    /** @internal */
    readonly _index: true;
    /** @internal The engine that owns this buffer. */
    readonly _engine: GLEngineContext;
    /** @internal */
    _disposed: boolean;
}

/** A non-instanced float attribute in composition geometry. */
export interface GLAttributeDescriptor {
    name: string;
    size: number;
    offset?: number;
    /** Lite GL treats an omitted divisor as instanced, so per-vertex attributes state `0`. */
    divisor: 0;
}

/** Attribute layout supplied by one vertex buffer. */
export interface GLMeshVertexBuffer {
    buffer: GLVertexBuffer;
    attributes: readonly GLAttributeDescriptor[];
    computeStride?: boolean;
}

/** Recorded composition geometry; the caller retains ownership of its buffers. */
export interface GLMeshVao {
    readonly indexCount: number;
    /** @internal */
    readonly _handle: NativeHandle;
    /** @internal The engine that owns this vertex array. */
    readonly _engine: GLEngineContext;
    /** @internal */
    _disposed: boolean;
}

/** Uploads immutable float vertex data. */
export function createVertexBuffer(engine: GLEngineContext, data: Float32Array): GLVertexBuffer {
    return {
        byteLength: data.byteLength,
        _handle: engine._native.createVertexBuffer(data.buffer, data.byteOffset, data.byteLength, false),
        _index: false,
        _engine: engine,
        _disposed: false,
    };
}

/** Uploads immutable index data. */
export function createIndexBuffer(engine: GLEngineContext, data: Uint16Array | Uint32Array): GLIndexBuffer {
    return {
        count: data.length,
        _handle: engine._native.createIndexBuffer(data.buffer, data.byteOffset, data.byteLength, data.BYTES_PER_ELEMENT === 4, false),
        _index: true,
        _engine: engine,
        _disposed: false,
    };
}

/** Records a mesh's attribute and index bindings independently of shader ownership. */
export function createMeshVao(engine: GLEngineContext, vertexBuffers: readonly GLMeshVertexBuffer[], indexBuffer: GLIndexBuffer, effect: GLEffect): GLMeshVao {
    const handle = engine._native.createVertexArray();
    const mesh: GLMeshVao = { indexCount: indexBuffer.count, _handle: handle, _engine: engine, _disposed: false };
    try {
        engine._native.recordIndexBuffer(handle, indexBuffer._handle);
        for (const binding of vertexBuffers) {
            let stride = 0;
            if (binding.computeStride) {
                for (const attribute of binding.attributes) {
                    stride += attribute.size * 4;
                }
            }
            for (const attribute of binding.attributes) {
                const location = effect._attributes[attribute.name] ?? -1;
                if (location >= 0) {
                    engine._native.recordVertexBuffer(
                        handle,
                        binding.buffer._handle,
                        location,
                        attribute.offset ?? 0,
                        stride || attribute.size * 4,
                        attribute.size,
                        engine._runtime.Engine.ATTRIB_TYPE_FLOAT,
                        false,
                        attribute.divisor
                    );
                }
            }
        }
        return mesh;
    } catch (error) {
        disposeMeshVao(mesh);
        throw error;
    }
}

/** Selects recorded geometry without repeating an unchanged native binding. */
export function bindMeshVao(mesh: GLMeshVao): void {
    const engine = mesh._engine;
    if (engine._vertexArray !== mesh._handle) {
        const commands = engine._commands;
        commands.start(engine._runtime.Engine.COMMAND_BINDVERTEXARRAY);
        commands.handle(mesh._handle);
        commands.finish();
        engine._vertexArray = mesh._handle;
    }
}

/** Draws a triangle range from recorded composition geometry. Native composition does not instance. */
export function drawMesh(mesh: GLMeshVao, _instanceCount: 0 = 0, indexStart = 0, indexCount = mesh.indexCount): void {
    const engine = mesh._engine;
    if (engine._disposed || mesh._disposed) {
        return;
    }
    bindMeshVao(mesh);
    const commands = engine._commands;
    commands.start(engine._runtime.Engine.COMMAND_DRAWINDEXED);
    commands.uint(0);
    commands.uint(indexStart);
    commands.uint(indexCount);
    commands.finish();
}

/** Releases owned vertex or index storage. */
export function disposeBuffer(buffer: GLVertexBuffer | GLIndexBuffer): void {
    if (!buffer._disposed) {
        buffer._disposed = true;
        const engine = buffer._engine;
        const commands = engine._commands;
        commands.start(buffer._index ? engine._runtime.Engine.COMMAND_DELETEINDEXBUFFER : engine._runtime.Engine.COMMAND_DELETEVERTEXBUFFER);
        commands.handle(buffer._handle);
        commands.finish();
    }
}

/** Releases recorded geometry without releasing its caller-owned buffers or shader. */
export function disposeMeshVao(mesh: GLMeshVao): void {
    if (!mesh._disposed) {
        mesh._disposed = true;
        const engine = mesh._engine;
        const commands = engine._commands;
        commands.start(engine._runtime.Engine.COMMAND_DELETEVERTEXARRAY);
        commands.handle(mesh._handle);
        commands.finish();
        if (engine._vertexArray === mesh._handle) {
            engine._vertexArray = null;
        }
    }
}
