/**
 * Indexed meshes, dynamic vertex/index buffers, and hardware instancing — the
 * Babylon Native backend of `src/mesh.ts`.
 *
 * Part of the public API via the `@babylonjs/lite-gl` native barrel. Mirrors the
 * WebGL module's public function signatures + names EXACTLY; only the backing
 * device work differs (Babylon Native command stream via the `d*` op-layer
 * instead of `gl.*`). The attribute binder reproduces Babylon's instancing
 * semantics: the `computeStride = false → stride 0` "sliding window" used by
 * ShapeBuilder's tape buffers and the `divisor === undefined → 1` default.
 *
 * NATIVE DIVERGENCES vs the WebGL module (documented per-function below):
 * 1. **No default/null VAO.** Native has no global attribute state to bind into,
 *    so the dynamic `bindAttributes` / `bindIndexBuffer` / `drawIndexed` path
 *    records into a TRANSIENT vertex array that is retired + rebuilt for each
 *    draw batch — mirrors `ThinNativeEngine.bindBuffers`, which deletes the
 *    previous `_boundBuffersVertexArray` before recording the next one.
 * 2. **Float-only attributes.** lite-gl feeds only `FLOAT` vertex data;
 *    `dRecordVertexBuffer` hardcodes `ATTRIB_TYPE_FLOAT` + non-normalized, so a
 *    descriptor's `type` / `normalized` fields are accepted (for API parity) but
 *    IGNORED on native.
 * 3. **One-call buffer upload.** `dCreateVertexBuffer` / `dCreateIndexBuffer`
 *    create AND upload in a single command — there is no separate bind +
 *    bufferData. Buffers retain their CPU data and re-upload on device-restore.
 * 4. **`indexStart` is in indices, not bytes.** Native `COMMAND_DRAWINDEXED`
 *    takes a UInt32 index offset directly (no `* elementSize` byte math).
 * 5. **`unbindInstanceAttributes` is a no-op** — each transient/mesh VAO isolates
 *    its own divisors, so a per-instance divisor never leaks into a following
 *    non-instanced draw the way a global `gl.vertexAttribDivisor` would.
 */
import type { GLEngineContext } from "./native-context.js";
import { onContextRestored, offContextRestored, type NativeDynBatch } from "./native-context.js";
import { getEffectAttributeLocation, type GLEffect } from "./effect.js";
import { applyNativeStates } from "./native-apply-states.js";
import type { NativeData } from "./native-types.js";
import {
    dCreateVertexBuffer,
    dUpdateVertexBuffer,
    dCreateIndexBuffer,
    dCreateVertexArray,
    dRecordVertexBuffer,
    dRecordIndexBuffer,
    dBindVertexArray,
    dDeleteVertexArray,
    dDeleteVertexBuffer,
    dDeleteIndexBuffer,
    dDrawIndexed,
} from "./native-device.js";

/** A GPU vertex buffer holding interleaved float vertex data. The native lite-gl
 *  counterpart of Babylon's `DataBuffer` for vertex data. Assignable to
 *  `NativeManagedBuffer`, so it lives in `engine._buffers` for restore replay. */
export interface GLVertexBuffer {
    /** The live native vertex-buffer handle. Swapped on device-restore. */
    handle: NativeData;
    /** Size of the GPU buffer in bytes. */
    byteLength: number;
    /** The engine that created (and owns) this buffer. @internal */
    _engine: GLEngineContext;
    /** @internal */
    _disposed: boolean;
    /** @internal Delete the underlying native buffer. */
    _deleteGpu: (engine: GLEngineContext) => void;
    /** @internal Re-create + re-upload the retained CPU data into a fresh handle. */
    _restore: (engine: GLEngineContext) => void;
    /** @internal Retained CPU data for device-restore replay (the creation /
     *  last full-buffer upload). */
    _data: Float32Array;
    /** @internal `true` for a dynamic buffer (updated via `updateVertexBuffer`). */
    _dynamic: boolean;
}

/** A GPU index buffer. The native lite-gl counterpart of Babylon's `DataBuffer`
 *  for index data. */
export interface GLIndexBuffer {
    /** The live native index-buffer handle. Swapped on device-restore. */
    handle: NativeData;
    /** Number of indices. */
    count: number;
    /** `true` for 32-bit (`Uint32Array`) indices, `false` for 16-bit. */
    is32Bits: boolean;
    /** The engine that created (and owns) this buffer. @internal */
    _engine: GLEngineContext;
    /** @internal */
    _disposed: boolean;
    /** @internal Delete the underlying native buffer. */
    _deleteGpu: (engine: GLEngineContext) => void;
    /** @internal Re-create + re-upload the retained CPU data into a fresh handle. */
    _restore: (engine: GLEngineContext) => void;
    /** @internal Retained CPU data for device-restore replay. */
    _data: Uint16Array | Uint32Array;
}

/**
 * Describes one vertex attribute fed from a buffer — the lite-gl equivalent of
 * Babylon's `InstancingAttributeInfo`. Pass an array of these to
 * {@link bindAttributes}.
 */
export interface GLAttributeDescriptor {
    /** Attribute name; resolved to a location via the effect when `index` is
     *  omitted (`getEffectAttributeLocation`). */
    name?: string;
    /** Explicit attribute location. When set, overrides the `name` lookup. */
    index?: number;
    /** Number of components, 1–4. */
    size: number;
    /** Byte offset of this attribute's first element within the buffer. Default 0. */
    offset?: number;
    /**
     * Per-instance vertex divisor. **Omitted/`undefined` → `1` (instanced)**,
     * matching Babylon's `bindInstancesBuffer`. Pass `0` explicitly for a
     * per-vertex attribute (e.g. the base mesh position).
     */
    divisor?: number;
    /** GL component type. **Ignored on native** (float-only); retained for API
     *  parity with the WebGL backend. */
    type?: number;
    /** Normalize fixed-point integer data. **Ignored on native** (float-only);
     *  retained for API parity with the WebGL backend. */
    normalized?: boolean;
}

/* ────────────────────────────────  buffers  ──────────────────────────────── */

/**
 * Create a GPU vertex buffer from interleaved float data.
 *
 * Native: created AND uploaded in one `dCreateVertexBuffer` command (no separate
 * bind + bufferData).
 *
 * @param engine - The engine.
 * @param data - The vertex data. Retained by reference for device-restore — do
 *  not mutate it in place; use {@link updateVertexBuffer} to change contents.
 * @param dynamic - Hint that the buffer will be updated frequently. Default
 *  `false`.
 * @returns The new {@link GLVertexBuffer}.
 */
export function createVertexBuffer(engine: GLEngineContext, data: Float32Array, dynamic = false): GLVertexBuffer {
    const handle = dCreateVertexBuffer(engine, data, dynamic);
    const vb: GLVertexBuffer = {
        handle,
        byteLength: data.byteLength,
        _data: data,
        _dynamic: dynamic,
        _engine: engine,
        _disposed: false,
        _deleteGpu: () => {},
        _restore: () => {},
    };
    vb._deleteGpu = (target: GLEngineContext): void => {
        dDeleteVertexBuffer(target, vb.handle);
    };
    vb._restore = (target: GLEngineContext): void => {
        vb.handle = dCreateVertexBuffer(target, vb._data, vb._dynamic);
    };
    engine._buffers.push(vb);
    return vb;
}

/**
 * Upload new contents into (part of) a vertex buffer. A full-buffer update from
 * offset 0 also refreshes the retained CPU data used for device-restore.
 *
 * @param vb - The vertex buffer to update (its engine is used).
 * @param data - The new float data.
 * @param dstByteOffset - Destination byte offset within the buffer. Default 0.
 */
export function updateVertexBuffer(vb: GLVertexBuffer, data: Float32Array, dstByteOffset = 0): void {
    const engine = vb._engine;
    if (engine._isLost || engine._disposed || vb._disposed) {
        return;
    }
    dUpdateVertexBuffer(engine, vb.handle, data, dstByteOffset);
    if (dstByteOffset === 0 && data.byteLength >= vb.byteLength) {
        vb._data = data;
        vb.byteLength = data.byteLength;
    }
}

/**
 * Create a GPU index buffer. `Uint16Array` → 16-bit indices, `Uint32Array` →
 * 32-bit.
 *
 * Native: created AND uploaded in one `dCreateIndexBuffer` command (no separate
 * bind + bufferData, and no VAO to protect — index bindings live inside each
 * VAO's recording).
 *
 * @param engine - The engine.
 * @param data - The index data. Retained by reference for device-restore.
 * @returns The new {@link GLIndexBuffer}.
 */
export function createIndexBuffer(engine: GLEngineContext, data: Uint16Array | Uint32Array): GLIndexBuffer {
    const is32 = data instanceof Uint32Array;
    const handle = dCreateIndexBuffer(engine, data, is32, false);
    const ib: GLIndexBuffer = {
        handle,
        count: data.length,
        is32Bits: is32,
        _data: data,
        _engine: engine,
        _disposed: false,
        _deleteGpu: () => {},
        _restore: () => {},
    };
    ib._deleteGpu = (target: GLEngineContext): void => {
        dDeleteIndexBuffer(target, ib.handle);
    };
    ib._restore = (target: GLEngineContext): void => {
        ib.handle = dCreateIndexBuffer(target, ib._data, ib.is32Bits, false);
    };
    engine._buffers.push(ib);
    return ib;
}

/** Dispose a vertex or index buffer (delete the native buffer + unregister).
 *  Clears the array/element-buffer cache slot if it pointed at this buffer.
 *  Idempotent. */
export function disposeBuffer(buffer: GLVertexBuffer | GLIndexBuffer): void {
    if (buffer._disposed) {
        return;
    }
    const engine = buffer._engine;
    buffer._disposed = true;
    const i = engine._buffers.indexOf(buffer);
    if (i !== -1) {
        engine._buffers.splice(i, 1);
    }
    const s = engine._state;
    if (!engine._isLost && !engine._disposed) {
        buffer._deleteGpu(engine);
    }
    if (s.boundArrayBuffer === buffer.handle) {
        s.boundArrayBuffer = null;
    }
    if (s.boundElementBuffer === buffer.handle) {
        s.boundElementBuffer = null;
    }
}

/* ──────────────────────────────  binding + draw  ──────────────────────────── */

/**
 * @internal The transient dynamic-draw batch lives ON the engine
 * (`engine._dynBatch`, see {@link NativeDynBatch}) — native has no default/null
 * VAO, so the `bindAttributes` → `bindIndexBuffer` → `drawIndexed` sequence
 * records into a throwaway vertex array (`vao`) retired + rebuilt each time a new
 * batch begins after a completed draw (`drawn === true`). Mirrors
 * `ThinNativeEngine.bindBuffers`. `ib` is the index-buffer handle already
 * recorded into `vao` (so `bindIndexBuffer` records at most once per batch).
 */

/** @internal Fetch (or lazily create) the engine's transient dynamic batch,
 *  registering a device-restore hook that drops the stale transient VAO handle.
 *  Stored on the engine (no module-level state — keeps the module side-effect-free). */
function _getDynBatch(engine: GLEngineContext): NativeDynBatch {
    let batch = engine._dynBatch;
    if (batch === null) {
        batch = { vao: null, ib: null, drawn: false };
        engine._dynBatch = batch;
        // Device-restore invalidates the transient VAO handle. resetNativeGLState
        // already forgot s.boundVao; drop our handle so the next batch rebuilds.
        const b = batch;
        onContextRestored(engine, (): void => {
            b.vao = null;
            b.ib = null;
            b.drawn = false;
        });
    }
    return batch;
}

/** @internal Ensure the batch has a fresh, recordable transient VAO. Retires the
 *  previous one once a draw has consumed it (matches `bindBuffers`, which deletes
 *  the previous transient VAO before recording the next). */
function _ensureDynVao(engine: GLEngineContext, batch: NativeDynBatch): NativeData {
    if (batch.drawn && batch.vao !== null) {
        const s = engine._state;
        if (s.boundVao === batch.vao) {
            s.boundVao = null;
            s.boundElementBuffer = null;
        }
        dDeleteVertexArray(engine, batch.vao);
        batch.vao = null;
    }
    batch.drawn = false;
    if (batch.vao === null) {
        batch.vao = dCreateVertexArray(engine);
        batch.ib = null;
    }
    return batch.vao;
}

/**
 * Bind an index buffer as the current element-array buffer — the lite-gl
 * equivalent of Babylon's `_bindIndexBufferWithCache`.
 *
 * Native: records the index buffer into the current transient batch VAO (at most
 * once per batch), since native index bindings live inside a VAO rather than in
 * global element-array state.
 *
 * @param ib - The index buffer to bind (its engine is used).
 */
export function bindIndexBuffer(ib: GLIndexBuffer): void {
    const engine = ib._engine;
    if (engine._isLost || engine._disposed || ib._disposed) {
        return;
    }
    const batch = _getDynBatch(engine);
    const vao = _ensureDynVao(engine, batch);
    if (batch.ib === ib.handle) {
        return;
    }
    dRecordIndexBuffer(engine, vao, ib.handle);
    batch.ib = ib.handle;
    engine._state.boundElementBuffer = ib.handle;
}

/**
 * Configure vertex attributes from `vb`, reproducing Babylon's
 * `bindInstancesBuffer`. For each descriptor: resolves the location (explicit
 * `index` or via the effect) and records a FLOAT attribute (with its stride,
 * offset, and divisor — `undefined → 1`) into the current transient batch VAO.
 *
 * `computeStride` controls the stride:
 * - `false` (default) → stride `0`: each attribute is independently tightly
 *   packed. Combined with overlapping `offset`s this yields the "sliding window"
 *   ShapeBuilder uses for distance-field tape buffers.
 * - `true` → stride = Σ(`size`·4 bytes): interleaved per-vertex/per-instance.
 *
 * NATIVE: records into a transient VAO (see {@link NativeDynBatch}); a descriptor's
 * `type` / `normalized` are ignored (float-only). No-op on a lost/disposed
 * context or before the effect is ready.
 *
 * @param vb - The buffer supplying the attribute data (its engine is used).
 * @param descriptors - The attribute layout.
 * @param effect - The effect whose attribute locations resolve unnamed indices.
 * @param computeStride - See above. Default `false`.
 */
export function bindAttributes(vb: GLVertexBuffer, descriptors: readonly GLAttributeDescriptor[], effect: GLEffect, computeStride = false): void {
    const engine = vb._engine;
    if (engine._isLost || engine._disposed || vb._disposed || !effect.isReady) {
        return;
    }
    const batch = _getDynBatch(engine);
    const vao = _ensureDynVao(engine, batch);

    let stride = 0;
    if (computeStride) {
        for (let i = 0; i < descriptors.length; i++) {
            stride += (descriptors[i] as GLAttributeDescriptor).size * 4;
        }
    }

    for (let i = 0; i < descriptors.length; i++) {
        const d = descriptors[i] as GLAttributeDescriptor;
        const loc = d.index !== undefined ? d.index : d.name !== undefined ? getEffectAttributeLocation(effect, d.name) : -1;
        if (loc < 0) {
            continue;
        }
        dRecordVertexBuffer(engine, vao, vb.handle, loc, d.offset ?? 0, stride, d.size, d.divisor === undefined ? 1 : d.divisor);
    }
}

/**
 * Reset the vertex divisor of every attribute touched by {@link bindAttributes} —
 * the lite-gl equivalent of Babylon's `unbindInstanceAttributes`.
 *
 * NATIVE: a documented **no-op**. Each transient/mesh VAO carries its own divisor
 * state (baked into the per-attribute record), so an instanced draw never skews a
 * following non-instanced draw the way a global `gl.vertexAttribDivisor` would.
 * Retained for API parity with the WebGL backend.
 *
 * @param engine - The engine.
 */
export function unbindInstanceAttributes(engine: GLEngineContext): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    // Intentionally empty on native — see the doc comment above.
}

/**
 * Draw indexed triangles from `ib` — the lite-gl equivalent of Babylon's
 * `drawElementsType` (triangle fill mode). When `instanceCount > 0` issues an
 * instanced draw, otherwise a plain indexed draw. No-op on a lost/disposed
 * context or when no program is current.
 *
 * NATIVE: binds the transient batch VAO (which carries the recorded attributes +
 * index), flushes deferred native state, then draws. `indexStart` is passed in
 * indices (native takes a UInt32 index offset directly — no byte math). The batch
 * is marked drawn so the next {@link bindAttributes} / {@link bindIndexBuffer}
 * retires + rebuilds a fresh transient VAO.
 *
 * @param ib - The index buffer (also recorded into the batch VAO, cached); its engine is used.
 * @param indexCount - Number of indices to draw.
 * @param indexStart - First index offset (in indices, not bytes). Default 0.
 * @param instanceCount - Instance count for instanced draws. Default 0
 *  (non-instanced).
 */
export function drawIndexed(ib: GLIndexBuffer, indexCount: number, indexStart = 0, instanceCount = 0): void {
    const engine = ib._engine;
    if (engine._isLost || engine._disposed || ib._disposed) {
        return;
    }
    if (engine._state.currentProgram === null) {
        return;
    }
    bindIndexBuffer(ib);
    const batch = _getDynBatch(engine);
    const vao = batch.vao;
    if (vao === null) {
        return;
    }
    const s = engine._state;
    if (s.boundVao !== vao) {
        dBindVertexArray(engine, vao);
        s.boundVao = vao;
        s.boundElementBuffer = ib.handle;
    }
    applyNativeStates(engine);
    dDrawIndexed(engine, indexStart, indexCount, instanceCount);
    batch.drawn = true;
}

/* ──────────────────────────  static mesh VAO  ─────────────────────────────
 * The VAO-cached counterpart of the manual `bindAttributes` path above — Babylon's
 * `recordVertexArrayObject` / `_cachedVertexArrayObject` for STATIC meshes. A
 * `GLMeshVao` records the whole attribute layout (pointer + divisor for
 * every attribute, across one or more vertex buffers) AND the index binding into
 * a single VAO ONCE. The per-frame draw is then just `bindVertexArray` +
 * `drawIndexed` — zero per-draw attribute records, and no
 * `unbindInstanceAttributes` (the VAO isolates the divisors). Use this for
 * fixed-layout meshes; keep `bindAttributes` for dynamic layouts (e.g.
 * ShapeBuilder's per-draw sliding-window tape buffers). */

/** One vertex buffer + its attribute layout, for {@link createMeshVao}. */
export interface GLMeshVertexBuffer {
    /** The buffer supplying this group's attributes. */
    buffer: GLVertexBuffer;
    /** The attributes read from `buffer` (same shape as {@link bindAttributes}). */
    attributes: readonly GLAttributeDescriptor[];
    /** Stride mode (see {@link bindAttributes}): `false` (default) → stride `0`
     *  per attribute; `true` → interleaved stride = Σ(`size`·4). */
    computeStride?: boolean;
}

/** A recorded Vertex Array Object capturing a static mesh's attribute layout +
 *  index binding. Bind + draw it with {@link drawMesh} each frame — the device
 *  replays the entire attribute setup from one `bindVertexArray`. Re-recorded
 *  automatically on device-restore. */
export interface GLMeshVao {
    /** The live native vertex-array handle. Swapped on device-restore. */
    handle: NativeData;
    /** The engine that created (and owns) this VAO. @internal */
    _engine: GLEngineContext;
    /** @internal */
    _disposed: boolean;
    /** @internal The index buffer recorded into the VAO. */
    _indexBuffer: GLIndexBuffer;
    /** @internal Resolved attribute bindings, reused to re-record on restore. */
    _bindings: _ResolvedBinding[];
    /** @internal Device-restore re-record hook. */
    _restore: () => void;
}

/** @internal A single attribute with its location resolved once at record time
 *  (locations are stable across re-link via `bindAttribLocation`, so the VAO can
 *  re-record on device-restore without the effect). `type` / `normalized` from
 *  the WebGL backend are dropped — native records are FLOAT-only. */
interface _ResolvedAttr {
    loc: number;
    size: number;
    stride: number;
    offset: number;
    divisor: number;
}

/** @internal A vertex buffer + its resolved attributes. */
interface _ResolvedBinding {
    buffer: GLVertexBuffer;
    attrs: _ResolvedAttr[];
}

/**
 * Record a static mesh's attribute layout + index binding into a new VAO. The
 * effect MUST be ready (its attribute locations are resolved here, once). Returns
 * a {@link GLMeshVao} to draw with {@link drawMesh}.
 *
 * @param engine - The engine.
 * @param vertexBuffers - One or more buffers + their attribute layouts.
 * @param indexBuffer - The index buffer recorded into the VAO.
 * @param effect - The effect whose attribute locations resolve unnamed indices.
 * @returns The recorded {@link GLMeshVao}.
 */
export function createMeshVao(engine: GLEngineContext, vertexBuffers: readonly GLMeshVertexBuffer[], indexBuffer: GLIndexBuffer, effect: GLEffect): GLMeshVao {
    // The effect's attribute locations are resolved (once) below; an unready effect
    // would resolve every name to -1 → a silently-empty VAO. Fail fast — callers
    // must gate on isEffectReady (see scene10's first-ready-frame creation).
    if (!effect.isReady) {
        throw new Error("lite-gl: createMeshVao requires a ready effect (poll isEffectReady first)");
    }
    // Resolve every attribute location ONCE (stable across re-link), so a restore
    // re-record needs only the buffer handles, not the effect.
    const bindings: _ResolvedBinding[] = [];
    for (const vbb of vertexBuffers) {
        let stride = 0;
        if (vbb.computeStride) {
            for (let i = 0; i < vbb.attributes.length; i++) {
                stride += (vbb.attributes[i] as GLAttributeDescriptor).size * 4;
            }
        }
        const attrs: _ResolvedAttr[] = [];
        for (let i = 0; i < vbb.attributes.length; i++) {
            const d = vbb.attributes[i] as GLAttributeDescriptor;
            const loc = d.index !== undefined ? d.index : d.name !== undefined ? getEffectAttributeLocation(effect, d.name) : -1;
            if (loc < 0) {
                continue;
            }
            attrs.push({
                loc,
                size: d.size,
                stride,
                offset: d.offset ?? 0,
                divisor: d.divisor === undefined ? 1 : d.divisor,
            });
        }
        bindings.push({ buffer: vbb.buffer, attrs });
    }
    const handle = dCreateVertexArray(engine);
    const vao: GLMeshVao = { handle, _engine: engine, _disposed: false, _indexBuffer: indexBuffer, _bindings: bindings, _restore: () => {} };
    vao._restore = (): void => {
        if (engine._isLost || engine._disposed || vao._disposed) {
            return;
        }
        vao.handle = dCreateVertexArray(engine);
        recordMeshVao(engine, vao);
    };
    recordMeshVao(engine, vao);
    onContextRestored(engine, vao._restore);
    return vao;
}

/**
 * Bind a {@link GLMeshVao} (cached `bindVertexArray`). Rarely called
 * directly — {@link drawMesh} binds it for you. Binding restores the VAO's
 * recorded element binding, so the element-buffer cache is updated in lock-step.
 *
 * @param vao - The mesh VAO to bind (its engine is used).
 */
export function bindMeshVao(vao: GLMeshVao): void {
    const engine = vao._engine;
    if (engine._isLost || engine._disposed || vao._disposed) {
        return;
    }
    const s = engine._state;
    if (s.boundVao === vao.handle) {
        return;
    }
    dBindVertexArray(engine, vao.handle);
    s.boundVao = vao.handle;
    s.boundElementBuffer = vao._indexBuffer.handle;
}

/**
 * Draw a static mesh recorded with {@link createMeshVao}: binds its VAO (cached),
 * flushes deferred native state, and issues ONE indexed draw (instanced when
 * `instanceCount > 0`) over the VAO's full index buffer. No per-draw attribute
 * (re)binding. No-op on a lost/disposed context, a disposed VAO, or when no
 * program is current.
 *
 * @param vao - The mesh VAO to draw (its engine is used).
 * @param instanceCount - Instance count for instanced draws. Default 0 (non-instanced).
 */
export function drawMesh(vao: GLMeshVao, instanceCount = 0): void {
    const engine = vao._engine;
    if (engine._isLost || engine._disposed || vao._disposed) {
        return;
    }
    if (engine._state.currentProgram === null) {
        return;
    }
    bindMeshVao(vao);
    applyNativeStates(engine);
    dDrawIndexed(engine, 0, vao._indexBuffer.count, instanceCount);
}

/** Dispose a {@link GLMeshVao}: delete the VAO and unregister its restore
 *  hook. Does NOT dispose the vertex/index buffers (the caller owns those).
 *  Idempotent. */
export function disposeMeshVao(vao: GLMeshVao): void {
    if (vao._disposed) {
        return;
    }
    const engine = vao._engine;
    vao._disposed = true;
    offContextRestored(engine, vao._restore);
    if (!engine._isLost && !engine._disposed) {
        const s = engine._state;
        dDeleteVertexArray(engine, vao.handle);
        if (s.boundVao === vao.handle) {
            // Native has no default VAO to return to; just forget the cache so the
            // next bind re-emits.
            s.boundVao = null;
            s.boundElementBuffer = null;
        }
    }
}

/** @internal Record `vao._bindings` + the index binding into `vao.handle`.
 *  Native records take the VAO handle explicitly, so — unlike the WebGL backend —
 *  there is no bind/unbind dance and the bound-VAO cache is left untouched
 *  ({@link drawMesh} binds explicitly). */
function recordMeshVao(engine: GLEngineContext, vao: GLMeshVao): void {
    const handle = vao.handle;
    for (const b of vao._bindings) {
        for (const a of b.attrs) {
            dRecordVertexBuffer(engine, handle, b.buffer.handle, a.loc, a.offset, a.stride, a.size, a.divisor);
        }
    }
    dRecordIndexBuffer(engine, handle, vao._indexBuffer.handle);
}
