import { BU } from "../engine/gpu-flags.js";
import type { StorageBuffer } from "../resource/storage-buffer.js";
import type { RenderBindingSet, RenderShader } from "./render-shader.js";
import { _assertRenderShaderLive } from "./render-shader.js";

/** Options for {@link createRenderDraw}. */
export interface RenderDrawOptions {
    /** Vertices per instance, or indices per instance when `indexBuffer` is set. */
    readonly vertexCount: number;
    readonly instanceCount?: number;
    readonly firstVertex?: number;
    readonly firstInstance?: number;
    /** One allocation created with `vertex: true` per layout in `RenderShaderOptions.vertexBuffers`, in order. */
    readonly vertexBuffers?: readonly StorageBuffer[];
    /** An allocation created with `index: true`; switches the draw to `drawIndexed`. */
    readonly indexBuffer?: StorageBuffer;
    readonly indexFormat?: GPUIndexFormat;
    readonly enabled?: boolean;
}

declare const renderDrawBrand: unique symbol;

/** One reusable draw of a render program with one immutable binding set. Counts are mutable per frame. */
export interface RenderDraw {
    readonly [renderDrawBrand]: true;
    readonly shader: RenderShader;
    readonly bindings: RenderBindingSet;
    enabled: boolean;
    /** @internal */
    _vertexCount: number;
    /** @internal */
    _instanceCount: number;
    /** @internal */
    _firstVertex: number;
    /** @internal */
    _firstInstance: number;
    /** @internal */
    readonly _vertexBuffers: readonly StorageBuffer[];
    /** @internal */
    readonly _indexBuffer: StorageBuffer | null;
    /** @internal */
    readonly _indexFormat: GPUIndexFormat;
    /** @internal Retained arrays installed only by the dynamic-offset setter. */
    _dynamicOffsets?: number[][];
    /** @internal Optional non-direct recorder, installed by indirect draw support. */
    _record?: (pass: GPURenderPassEncoder, draw: RenderDraw) => void;
    /** @internal Indirect source installed only by the opt-in indirect module. */
    _indirectBuffer?: StorageBuffer;
    /** @internal */
    _indirectOffset?: number;
}

function validateCount(name: string, value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new Error(`RenderDraw: ${name} must be an unsigned 32-bit integer, received ${value}.`);
    }
}

function validateBuffer(draw: string, buffer: StorageBuffer, usage: number, role: string, shader: RenderShader): void {
    if (buffer._destroyed || buffer._engine !== shader._program._engine) {
        throw new Error(`RenderDraw ${draw}: ${role} buffer is disposed or belongs to a different engine.`);
    }
    if ((buffer._usage & usage) === 0) {
        throw new Error(`RenderDraw ${draw}: ${role} buffer was not created with the ${role} usage.`);
    }
}

/** Create a reusable draw record. Nothing is recorded until a {@link RenderDrawTask} executes it. */
export function createRenderDraw(shader: RenderShader, bindings: RenderBindingSet, options: RenderDrawOptions): RenderDraw {
    _assertRenderShaderLive(shader);
    if (bindings.shader !== shader) {
        throw new Error("RenderDraw: binding set belongs to a different RenderShader.");
    }
    const vertexBuffers = options.vertexBuffers ?? [];
    const layouts = shader._options.vertexBuffers ?? [];
    if (vertexBuffers.length !== layouts.length) {
        throw new Error(`RenderDraw "${shader.name}": the shader declares ${layouts.length} vertex buffers, received ${vertexBuffers.length}.`);
    }
    for (const buffer of vertexBuffers) {
        validateBuffer(`"${shader.name}"`, buffer, BU.VERTEX, "vertex", shader);
    }
    const indexBuffer = options.indexBuffer ?? null;
    if (indexBuffer) {
        validateBuffer(`"${shader.name}"`, indexBuffer, BU.INDEX, "index", shader);
    }
    const draw = {
        shader,
        bindings,
        enabled: options.enabled ?? true,
        _vertexCount: 0,
        _instanceCount: 1,
        _firstVertex: options.firstVertex ?? 0,
        _firstInstance: options.firstInstance ?? 0,
        _vertexBuffers: vertexBuffers.slice(),
        _indexBuffer: indexBuffer,
        _indexFormat: options.indexFormat ?? "uint32",
    } as unknown as RenderDraw;
    validateCount("firstVertex", draw._firstVertex);
    validateCount("firstInstance", draw._firstInstance);
    setRenderDrawCount(draw, options.vertexCount, options.instanceCount ?? 1);
    return draw;
}

/** Replace the vertex (or index) and instance counts. Scalars only, so per-frame updates allocate nothing. */
export function setRenderDrawCount(draw: RenderDraw, vertexCount: number, instanceCount = 1): void {
    validateCount("vertexCount", vertexCount);
    validateCount("instanceCount", instanceCount);
    draw._vertexCount = vertexCount;
    draw._instanceCount = instanceCount;
    draw._record = undefined;
}

/** Mutate one retained dynamic-offset slot, allocating the offset arrays only on first use. */
export function setRenderDrawDynamicOffset(draw: RenderDraw, bindingName: string, byteOffset: number): void {
    const set = draw.bindings._set;
    const slot = set._dynamicSlots?.get(bindingName);
    if (!slot) {
        throw new Error(`RenderDraw: binding "${bindingName}" is not a dynamic buffer binding.`);
    }
    if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset % slot._alignment !== 0) {
        throw new Error(`RenderDraw: dynamic offset for "${bindingName}" must be a non-negative multiple of ${slot._alignment}.`);
    }
    if (byteOffset > slot._maxOffset) {
        throw new Error(`RenderDraw: dynamic offset for "${bindingName}" exceeds the bound buffer range.`);
    }
    const offsets = (draw._dynamicOffsets ??= draw.shader._program._dynamicCounts.map((count) => new Array<number>(count).fill(0)));
    offsets[slot._group]![slot._index] = byteOffset;
}
