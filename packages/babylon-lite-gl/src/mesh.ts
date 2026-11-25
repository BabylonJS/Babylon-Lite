/**
 * Indexed meshes, dynamic vertex/index buffers, and hardware instancing.
 *
 * Part of the public API via the `@babylonjs/lite-gl` barrel. The package is
 * `sideEffects: false`, so consumers that only render the fullscreen quad /
 * sprites tree-shake the mesh code out.
 *
 * This is the lite-gl equivalent of Babylon's `ThinEngine.createVertexBuffer` /
 * `createIndexBuffer` / `_releaseBuffer` / `bindIndexBuffer` /
 * `bindInstancesBuffer` / `unbindInstanceAttributes` / `drawElementsType`. The
 * attribute binder reproduces Babylon's instancing semantics EXACTLY, including
 * the `computeStride = false → stride 0` "sliding window" used by distance-field
 * tape buffers (consecutive instances read overlapping vec4 windows) and the
 * `divisor === undefined → 1` default.
 *
 * The mesh path runs on the DEFAULT (null) VAO — every buffer/attribute op binds
 * `gl.bindVertexArray(null)` first, so it never corrupts the quad / sprite VAOs.
 * Unless the engine is host-owned (`createHostOwnedGLEngine`), vertex/index buffers retain their CPU
 * data and re-upload automatically on `webglcontextrestored`.
 */
import type { GLEngineContext } from "./context.js";
import { onContextRestored, offContextRestored } from "./context.js";
import { getEffectAttributeLocation, type GLEffect } from "./effect.js";
import { applyGLStates } from "./apply-states.js";

/** GL `gl.ARRAY_BUFFER`. */
const ARRAY_BUFFER = 0x8892;
/** GL `gl.ELEMENT_ARRAY_BUFFER`. */
const ELEMENT_ARRAY_BUFFER = 0x8893;
/** GL `gl.STATIC_DRAW`. */
const STATIC_DRAW = 0x88e4;
/** GL `gl.DYNAMIC_DRAW`. */
const DYNAMIC_DRAW = 0x88e8;
/** GL `gl.FLOAT`. */
const FLOAT = 0x1406;
/** GL `gl.TRIANGLES`. */
const TRIANGLES = 0x0004;
/** GL `gl.UNSIGNED_SHORT`. */
const UNSIGNED_SHORT = 0x1403;
/** GL `gl.UNSIGNED_INT`. */
const UNSIGNED_INT = 0x1405;

/** A GPU vertex buffer holding interleaved float vertex data. The lite-gl
 *  counterpart of Babylon's `DataBuffer` for vertex data. */
export interface GLVertexBuffer {
    /** The live `WebGLBuffer`. Swapped on `webglcontextrestored`. */
    handle: WebGLBuffer;
    /** Size of the GL buffer in bytes. */
    byteLength: number;
    /** The engine that created (and owns) this buffer. Operations on it derive
     *  their engine from here, so they take the buffer alone. @internal */
    _engine: GLEngineContext;
    /** @internal */
    _disposed: boolean;
    /** @internal Delete the underlying GL buffer. */
    _deleteGpu: (gl: WebGL2RenderingContext) => void;
    /** @internal Re-create + re-upload the retained CPU data into a fresh handle. */
    _restore?: (engine: GLEngineContext) => void;
    /** @internal Retained CPU data for context-restore replay (the creation /
     *  last full-buffer upload). */
    _data?: Float32Array;
    /** @internal `true` for `DYNAMIC_DRAW` (updated via `updateVertexBuffer`). */
    _dynamic: boolean;
}

/** A GPU index buffer. The lite-gl counterpart of Babylon's `DataBuffer` for
 *  index data. */
export interface GLIndexBuffer {
    /** The live `WebGLBuffer`. Swapped on `webglcontextrestored`. */
    handle: WebGLBuffer;
    /** Number of indices. */
    count: number;
    /** `true` for 32-bit (`Uint32Array`) indices, `false` for 16-bit. */
    is32Bits: boolean;
    /** The engine that created (and owns) this buffer. Operations on it derive
     *  their engine from here, so they take the buffer alone. @internal */
    _engine: GLEngineContext;
    /** @internal */
    _disposed: boolean;
    /** @internal Delete the underlying GL buffer. */
    _deleteGpu: (gl: WebGL2RenderingContext) => void;
    /** @internal Re-create + re-upload the retained CPU data into a fresh handle. */
    _restore?: (engine: GLEngineContext) => void;
    /** @internal Retained CPU data for context-restore replay. */
    _data?: Uint16Array | Uint32Array;
}

/**
 * Describes one vertex attribute fed from a buffer — the lite-gl equivalent of
 * Babylon's `InstancingAttributeInfo`. Pass an array of these to
 * {@link bindAttributes}.
 */
export interface GLAttributeDescriptor {
    /** Attribute name; resolved to a location via the effect when `index` is
     *  omitted (`Effect.getAttributeLocationByName`). */
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
    /** GL component type. Default `gl.FLOAT`. */
    type?: GLenum;
    /** Normalize fixed-point integer data to `[0,1]`/`[-1,1]`. Default `false`. */
    normalized?: boolean;
}

/* ────────────────────────────────  buffers  ──────────────────────────────── */

/**
 * Create a GPU vertex buffer from interleaved float data.
 *
 * @param engine - The engine.
 * @param data - The vertex data. Retained by reference unless the engine opts out of context restoration — do
 *  not mutate it in place; use {@link updateVertexBuffer} to change contents.
 * @param dynamic - Hint that the buffer will be updated frequently
 *  (`DYNAMIC_DRAW`). Default `false` (`STATIC_DRAW`).
 * @returns The new {@link GLVertexBuffer}.
 */
export function createVertexBuffer(engine: GLEngineContext, data: Float32Array, dynamic = false): GLVertexBuffer {
    const gl = engine.gl;
    const handle = gl.createBuffer();
    if (handle === null) {
        throw new Error("lite-gl: gl.createBuffer returned null (vertex buffer)");
    }
    const vb: GLVertexBuffer = {
        handle,
        byteLength: data.byteLength,
        _dynamic: dynamic,
        _engine: engine,
        _disposed: false,
        _deleteGpu: (g: WebGL2RenderingContext): void => {
            g.deleteBuffer(vb.handle);
        },
    };
    if (!engine._noRestore) {
        vb._data = data;
        vb._restore = (target: GLEngineContext): void => {
            const g = target.gl;
            const fresh = g.createBuffer();
            if (fresh === null) {
                return;
            }
            vb.handle = fresh;
            bindArrayBufferRaw(target, fresh);
            g.bufferData(ARRAY_BUFFER, vb._data!, vb._dynamic ? DYNAMIC_DRAW : STATIC_DRAW);
        };
    }
    bindArrayBufferRaw(engine, handle);
    gl.bufferData(ARRAY_BUFFER, data, dynamic ? DYNAMIC_DRAW : STATIC_DRAW);
    engine._buffers.push(vb);
    return vb;
}

/**
 * Upload new contents into (part of) a vertex buffer via `bufferSubData`. A
 * full-buffer update from offset 0 also refreshes the retained CPU data used
 * for context-restore unless the engine opts out. Neither mode copies the input.
 *
 * @param vb - The vertex buffer to update.
 * @param data - The new float data.
 * @param dstByteOffset - Destination byte offset within the buffer. Default 0.
 */
export function updateVertexBuffer(vb: GLVertexBuffer, data: Float32Array, dstByteOffset = 0): void {
    const engine = vb._engine;
    if (engine._isLost || engine._disposed || vb._disposed) {
        return;
    }
    bindArrayBufferRaw(engine, vb.handle);
    engine.gl.bufferSubData(ARRAY_BUFFER, dstByteOffset, data);
    if (dstByteOffset === 0 && data.byteLength >= vb.byteLength) {
        if (!engine._noRestore) {
            vb._data = data;
        }
        vb.byteLength = data.byteLength;
    }
}

/**
 * Create a GPU index buffer. `Uint16Array` → 16-bit indices, `Uint32Array` →
 * 32-bit. Binds the default VAO first so it never corrupts the quad / sprite
 * VAO element bindings.
 *
 * @param engine - The engine.
 * @param data - The index data. Retained by reference unless the engine opts out of context restoration.
 * @returns The new {@link GLIndexBuffer}.
 */
export function createIndexBuffer(engine: GLEngineContext, data: Uint16Array | Uint32Array): GLIndexBuffer {
    const gl = engine.gl;
    const handle = gl.createBuffer();
    if (handle === null) {
        throw new Error("lite-gl: gl.createBuffer returned null (index buffer)");
    }
    const is32 = data instanceof Uint32Array;
    const ib: GLIndexBuffer = {
        handle,
        count: data.length,
        is32Bits: is32,
        _engine: engine,
        _disposed: false,
        _deleteGpu: (g: WebGL2RenderingContext): void => {
            g.deleteBuffer(ib.handle);
        },
    };
    if (!engine._noRestore) {
        ib._data = data;
        ib._restore = (target: GLEngineContext): void => {
            const g = target.gl;
            const fresh = g.createBuffer();
            if (fresh === null) {
                return;
            }
            ib.handle = fresh;
            bindDefaultVao(target);
            g.bindBuffer(ELEMENT_ARRAY_BUFFER, fresh);
            target._state.boundElementBuffer = fresh;
            g.bufferData(ELEMENT_ARRAY_BUFFER, ib._data!, STATIC_DRAW);
        };
    }
    bindDefaultVao(engine);
    gl.bindBuffer(ELEMENT_ARRAY_BUFFER, handle);
    engine._state.boundElementBuffer = handle;
    gl.bufferData(ELEMENT_ARRAY_BUFFER, data, STATIC_DRAW);
    engine._buffers.push(ib);
    return ib;
}

/** Dispose a vertex or index buffer (delete the GL buffer + unregister). Clears
 *  the array/element-buffer cache slot if it pointed at this buffer and releases
 *  retained upload/restore references in both recovery modes. Idempotent. */
export function disposeBuffer(buffer: GLVertexBuffer | GLIndexBuffer): void {
    const engine = buffer._engine;
    if (buffer._disposed) {
        return;
    }
    buffer._disposed = true;
    buffer._data = buffer._restore = undefined;
    const i = engine._buffers.indexOf(buffer);
    if (i !== -1) {
        engine._buffers.splice(i, 1);
    }
    const s = engine._state;
    if (!engine._isLost && !engine._disposed) {
        engine.gl.deleteBuffer(buffer.handle);
    }
    if (s.boundArrayBuffer === buffer.handle) {
        s.boundArrayBuffer = null;
    }
    if (s.boundElementBuffer === buffer.handle) {
        s.boundElementBuffer = null;
    }
    for (let location = 0; location < s.enabledAttribs.length; location++) {
        if (s.enabledAttribs[location] === buffer.handle) {
            s.enabledAttribs[location] = true;
        }
    }
}

/* ──────────────────────────────  binding + draw  ──────────────────────────── */

/**
 * Bind an index buffer as the current element-array buffer (on the default
 * VAO). Cached. The lite-gl equivalent of Babylon's `_bindIndexBufferWithCache`.
 *
 * @param ib - The index buffer to bind.
 */
export function bindIndexBuffer(ib: GLIndexBuffer): void {
    const engine = ib._engine;
    if (engine._isLost || engine._disposed || ib._disposed) {
        return;
    }
    bindDefaultVao(engine);
    const s = engine._state;
    if (s.boundElementBuffer === ib.handle) {
        return;
    }
    engine.gl.bindBuffer(ELEMENT_ARRAY_BUFFER, ib.handle);
    s.boundElementBuffer = ib.handle;
}

/**
 * Configure vertex attributes from `vb`, reproducing Babylon's
 * `bindInstancesBuffer` exactly. For each descriptor: resolves the location
 * (explicit `index` or via the effect), enables the attribute array (cached),
 * issues `vertexAttribPointer`, and sets the vertex divisor (`undefined → 1`).
 * Each instanced location (divisor ≠ 0) is tracked once so {@link unbindInstanceAttributes}
 * can reset its divisor afterwards; per-vertex locations already have divisor 0 and are
 * not tracked, so callers that never instance can rebind every frame without growth.
 *
 * `computeStride` controls the GL stride passed to `vertexAttribPointer`:
 * - `false` (default) → stride `0`: each attribute is independently tightly
 *   packed. Combined with overlapping `offset`s this yields the "sliding window"
 *   used by distance-field tape buffers.
 * - `true` → stride = Σ(`size`·4 bytes): interleaved per-vertex/per-instance.
 *
 * Every call re-issues `vertexAttribPointer`. Callers that rebind an equivalent
 * layout every draw (e.g. a 2D shape renderer) should use {@link bindAttributesCached},
 * which elides unchanged pointers; the two can be mixed freely.
 *
 * Runs on the default (null) VAO — never corrupts the quad / sprite VAOs.
 * No-op on a lost/disposed context or before the effect is ready.
 *
 * @param vb - The buffer supplying the attribute data.
 * @param descriptors - The attribute layout.
 * @param effect - The effect whose attribute locations resolve unnamed indices.
 * @param computeStride - See above. Default `false`.
 */
export function bindAttributes(vb: GLVertexBuffer, descriptors: readonly GLAttributeDescriptor[], effect: GLEffect, computeStride = false): void {
    const engine = vb._engine;
    if (engine._isLost || engine._disposed || vb._disposed || !effect.isReady) {
        return;
    }
    const gl = engine.gl;
    const s = engine._state;
    bindDefaultVao(engine);
    bindArrayBufferRaw(engine, vb.handle);

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
        if (!s.enabledAttribs[loc]) {
            gl.enableVertexAttribArray(loc);
        }
        // Enabled, but with a pointer bindAttributesCached must not trust.
        s.enabledAttribs[loc] = true;
        gl.vertexAttribPointer(loc, d.size, d.type ?? FLOAT, d.normalized ?? false, stride, d.offset ?? 0);
        const divisor = d.divisor ?? 1;
        gl.vertexAttribDivisor(loc, divisor);
        if (divisor !== 0 && !s.instanceLocations.includes(loc)) {
            s.instanceLocations.push(loc);
        }
    }
}

/**
 * {@link bindAttributes} with a default-VAO attribute cache: `vertexAttribPointer`
 * is issued only when a location's (buffer handle, size, type, normalized,
 * stride, offset) tuple changes, and `vertexAttribDivisor` only when its divisor
 * changes, so rebinding an equivalent layout every draw (e.g. per-shape binds in a
 * 2D shape renderer) issues no attribute calls. Divisors are tracked through
 * `instanceLocations`, so {@link unbindInstanceAttributes} needs no cache code.
 * Semantics, parameters and no-op conditions are
 * otherwise identical to {@link bindAttributes}.
 *
 * The cache (4 numbers per `MAX_VERTEX_ATTRIBS` location) is allocated once on
 * the first effective call; later binds allocate nothing. Disabling an
 * attribute, {@link bindAttributes}, cache wipes/resets and context loss
 * invalidate the affected tuples, and a recreated buffer handle never matches
 * a stale one. Named VAOs keep independent state.
 *
 * @param vb - The buffer supplying the attribute data.
 * @param descriptors - The attribute layout.
 * @param effect - The effect whose attribute locations resolve unnamed indices.
 * @param computeStride - See {@link bindAttributes}. Default `false`.
 */
export function bindAttributesCached(vb: GLVertexBuffer, descriptors: readonly GLAttributeDescriptor[], effect: GLEffect, computeStride = false): void {
    const engine = vb._engine;
    if (engine._isLost || engine._disposed || vb._disposed || !effect.isReady) {
        return;
    }
    const gl = engine.gl;
    const s = engine._state;
    bindDefaultVao(engine);
    bindArrayBufferRaw(engine, vb.handle);
    const values = (s._attributePointers ??= new Float64Array((gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number) * 4));

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
        const enabled = s.enabledAttribs[loc];
        if (!enabled) {
            gl.enableVertexAttribArray(loc);
        }
        const type = d.type ?? FLOAT;
        const normalized = d.normalized ?? false;
        const offset = d.offset ?? 0;
        // A GLenum fits in 32 bits; packing the valid 1..4 size and normalize
        // flag leaves one exact (53-bit) number instead of three cache slots.
        const format = type * 16 + d.size * 2 + +normalized;
        const slot = loc * 4;
        if (enabled !== vb.handle || values[slot] !== format || values[slot + 1] !== stride || values[slot + 2] !== offset) {
            gl.vertexAttribPointer(loc, d.size, type, normalized, stride, offset);
            values[slot] = format;
            values[slot + 1] = stride;
            values[slot + 2] = offset;
        }
        const divisor = d.divisor ?? 1;
        // While this binder owns the location (a buffer handle, not `true`/null),
        // every non-zero divisor it sets is listed in instanceLocations, and only
        // unbindInstanceAttributes (which resets listed divisors to 0) or a cache
        // reset (which also drops ownership) clears that list. An owned, unlisted
        // location therefore has divisor 0; a listed one has the cached divisor.
        const listed = s.instanceLocations.includes(loc);
        if (!enabled || enabled === true || (listed ? values[slot + 3] : 0) !== divisor) {
            gl.vertexAttribDivisor(loc, divisor);
            values[slot + 3] = divisor;
            if (divisor !== 0 && !listed) {
                s.instanceLocations.push(loc);
            }
        }
        s.enabledAttribs[loc] = vb.handle;
    }
}

/**
 * Disable an enabled attribute on the default VAO, eliding redundant calls.
 * Leaves its divisor unchanged, like ThinEngine's `disableAttributeByIndex`;
 * use {@link unbindInstanceAttributes} for divisor cleanup. Named VAOs are
 * untouched. No-op on a lost/disposed engine. The enable cache is cleared on
 * context loss or cache reset, so subsequent binds replay their enables. After
 * a plain `wipeGLStateCache`, a location lite-gl has not confirmed
 * disabled is treated as unknown (the host may have enabled it) and is disabled.
 *
 * @param engine - The engine.
 * @param location - The attribute location to disable.
 */
export function disableAttributeByIndex(engine: GLEngineContext, location: number): void {
    const s = engine._state;
    const enabled = s.enabledAttribs[location];
    if (engine._isLost || engine._disposed || (s._unknownAttribs ? enabled === null : !enabled)) {
        return;
    }
    bindDefaultVao(engine);
    engine.gl.disableVertexAttribArray(location);
    s.enabledAttribs[location] = null;
}

/**
 * Disable all enabled default-VAO attributes in ascending location order.
 * Cached across frames and allocation-free; named VAOs and instance divisors
 * are unchanged (ThinEngine's `unbindAllAttributes` semantics). No-op on a
 * lost/disposed engine. Context loss/cache reset clears the enable cache;
 * subsequent {@link bindAttributes} calls replay their enables. The first call
 * after a plain `wipeGLStateCache` disables every location up to
 * `MAX_VERTEX_ATTRIBS` once, since the host may have enabled any of them.
 *
 * @param engine - The engine.
 */
export function unbindAllAttributes(engine: GLEngineContext): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const s = engine._state;
    const count = s._unknownAttribs ? (engine.gl.getParameter(engine.gl.MAX_VERTEX_ATTRIBS) as number) : s.enabledAttribs.length;
    for (let location = 0; location < count; location++) {
        disableAttributeByIndex(engine, location);
    }
    s._unknownAttribs = false;
}

/**
 * Reset the vertex divisor of every attribute touched by {@link bindAttributes}
 * or {@link bindAttributesCached} back to 0 — the lite-gl equivalent of Babylon's `unbindInstanceAttributes`.
 * Call after an instanced draw so a following non-instanced draw is not skewed.
 * No-op on a lost/disposed context.
 *
 * @param engine - The engine.
 */
export function unbindInstanceAttributes(engine: GLEngineContext): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const gl = engine.gl;
    const locs = engine._state.instanceLocations;
    for (let i = 0; i < locs.length; i++) {
        gl.vertexAttribDivisor(locs[i] as number, 0);
    }
    locs.length = 0;
}

/**
 * Draw indexed triangles from `ib` — the lite-gl equivalent of Babylon's
 * `drawElementsType` (triangle fill mode). When `instanceCount > 0` issues
 * `drawElementsInstanced`, otherwise `drawElements`. No-op on a lost/disposed
 * context or when no program is current.
 *
 * @param ib - The index buffer (also bound as a side-effect, cached).
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
    const gl = engine.gl;
    const type = ib.is32Bits ? UNSIGNED_INT : UNSIGNED_SHORT;
    const byteOffset = indexStart * (ib.is32Bits ? 4 : 2);
    applyGLStates(engine);
    if (instanceCount > 0) {
        gl.drawElementsInstanced(TRIANGLES, indexCount, type, byteOffset, instanceCount);
    } else {
        gl.drawElements(TRIANGLES, indexCount, type, byteOffset);
    }
}

/* ──────────────────────────  static mesh VAO  ─────────────────────────────
 * The VAO-cached counterpart of the manual `bindAttributes` path above — Babylon's
 * `recordVertexArrayObject` / `_cachedVertexArrayObject` for STATIC meshes. A
 * `GLMeshVao` records the whole attribute layout (enable + pointer + divisor for
 * every attribute, across one or more vertex buffers) AND the index binding into a
 * single VAO ONCE. The per-frame draw is then just `bindVertexArray` +
 * `drawElements[Instanced]` — zero per-draw `vertexAttribPointer`/`vertexAttribDivisor`,
 * and no `unbindInstanceAttributes` (the VAO isolates the divisors from the default
 * VAO). Use this for fixed-layout meshes; keep `bindAttributes` for dynamic layouts
 * (e.g. per-draw sliding-window tape buffers). */

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
 *  index binding. Bind + draw it with {@link drawMesh} each frame — the GPU
 *  replays the entire attribute setup from one `bindVertexArray`. Re-recorded
 *  automatically on `webglcontextrestored` unless the engine is host-owned
 *  (`createHostOwnedGLEngine`). */
export interface GLMeshVao {
    /** The live `WebGLVertexArrayObject`. Swapped on `webglcontextrestored`. */
    handle: WebGLVertexArrayObject;
    /** The engine that created (and owns) this VAO. Operations on it derive
     *  their engine from here, so they take the VAO alone. @internal */
    _engine: GLEngineContext;
    /** @internal */
    _disposed: boolean;
    /** @internal The index buffer recorded into the VAO. */
    _indexBuffer: GLIndexBuffer;
    /** @internal Resolved attribute bindings, reused to re-record on restore. */
    _bindings: _ResolvedBinding[];
    /** @internal `webglcontextrestored` re-record hook. */
    _restore?: () => void;
}

/** @internal A single attribute with its location resolved once at record time
 *  (locations are stable across re-link via `bindAttribLocation`, so the VAO can
 *  re-record on context-restore without the effect). */
interface _ResolvedAttr {
    loc: number;
    size: number;
    type: number;
    normalized: boolean;
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
    const gl = engine.gl;
    // The effect's attribute locations are resolved (once) below; an unready effect
    // would resolve every name to -1 → a silently-empty VAO. Fail fast — callers
    // must gate on isEffectReady (see scene10's first-ready-frame creation).
    if (!effect.isReady) {
        throw new Error("lite-gl: createMeshVao requires a ready effect (poll isEffectReady first)");
    }
    const handle = gl.createVertexArray();
    if (handle === null) {
        throw new Error("lite-gl: gl.createVertexArray returned null (mesh VAO)");
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
                type: d.type ?? FLOAT,
                normalized: d.normalized ?? false,
                stride,
                offset: d.offset ?? 0,
                divisor: d.divisor === undefined ? 1 : d.divisor,
            });
        }
        bindings.push({ buffer: vbb.buffer, attrs });
    }
    const vao: GLMeshVao = { handle, _engine: engine, _disposed: false, _indexBuffer: indexBuffer, _bindings: bindings };
    if (!engine._noRestore) {
        vao._restore = (): void => {
            if (engine._isLost || engine._disposed || vao._disposed) {
                return;
            }
            const fresh = engine.gl.createVertexArray();
            if (fresh === null) {
                return;
            }
            vao.handle = fresh;
            recordMeshVao(engine, vao);
        };
        onContextRestored(engine, vao._restore);
    }
    recordMeshVao(engine, vao);
    if (engine._noRestore) {
        bindings.length = 0;
    }
    return vao;
}

/**
 * Bind a {@link GLMeshVao} (cached `gl.bindVertexArray`). Rarely called directly —
 * {@link drawMesh} binds it for you. Binding restores the VAO's recorded element
 * binding, so the element-buffer cache is updated in lock-step.
 *
 * @param vao - The mesh VAO to bind.
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
    engine.gl.bindVertexArray(vao.handle);
    s.boundVao = vao.handle;
    s.boundElementBuffer = vao._indexBuffer.handle;
}

/**
 * Draw a static mesh recorded with {@link createMeshVao}: binds its VAO (cached),
 * flushes deferred GL state, and issues ONE `drawElements` (or
 * `drawElementsInstanced` when `instanceCount > 0`) over the VAO's full index
 * buffer. No per-draw attribute (re)binding. No-op on a lost/disposed context, a
 * disposed VAO, or when no program is current.
 *
 * @param vao - The mesh VAO to draw.
 * @param instanceCount - Instance count for instanced draws. Default 0 (non-instanced).
 * @param indexStart - First index in the retained mesh.
 * @param indexCount - Number of indices; defaults to the indices from `indexStart` to the end of the mesh.
 * @throws RangeError when the range is not whole indices within the mesh.
 */
export function drawMesh(vao: GLMeshVao, instanceCount = 0, indexStart = 0, indexCount = vao._indexBuffer.count - indexStart): void {
    const total = vao._indexBuffer.count;
    if (!Number.isInteger(indexStart) || !Number.isInteger(indexCount) || indexStart < 0 || indexCount < 0 || indexStart + indexCount > total) {
        throw new RangeError(`lite-gl: drawMesh range (start ${indexStart}, count ${indexCount}) must be whole indices within the mesh's ${total}`);
    }
    const engine = vao._engine;
    if (engine._isLost || engine._disposed || vao._disposed) {
        return;
    }
    if (engine._state.currentProgram === null) {
        return;
    }
    bindMeshVao(vao);
    applyGLStates(engine);
    const ib = vao._indexBuffer;
    const gl = engine.gl;
    const type = ib.is32Bits ? UNSIGNED_INT : UNSIGNED_SHORT;
    if (instanceCount > 0) {
        gl.drawElementsInstanced(TRIANGLES, indexCount, type, indexStart * (ib.is32Bits ? 4 : 2), instanceCount);
    } else {
        gl.drawElements(TRIANGLES, indexCount, type, indexStart * (ib.is32Bits ? 4 : 2));
    }
}

/** Dispose a {@link GLMeshVao}: delete the VAO and unregister its restore hook.
 *  Does NOT dispose the vertex/index buffers (the caller owns those). Idempotent. */
export function disposeMeshVao(vao: GLMeshVao): void {
    const engine = vao._engine;
    if (vao._disposed) {
        return;
    }
    vao._disposed = true;
    if (vao._restore) {
        offContextRestored(engine, vao._restore);
    }
    if (!engine._isLost && !engine._disposed) {
        const s = engine._state;
        engine.gl.deleteVertexArray(vao.handle);
        if (s.boundVao === vao.handle) {
            // Return to the default VAO so the cache stays coherent.
            engine.gl.bindVertexArray(null);
            s.boundVao = null;
            s.boundElementBuffer = null;
        }
    }
}

/** @internal Record `vao._bindings` + the index binding into `vao.handle`. Leaves
 *  the default (null) VAO bound afterwards (so the mesh VAO is not left current),
 *  forgetting the element-buffer cache. Touches neither `s.enabledAttribs` (those
 *  track the DEFAULT VAO) nor the divisor reset — all of that lives in the VAO. */
function recordMeshVao(engine: GLEngineContext, vao: GLMeshVao): void {
    const gl = engine.gl;
    const s = engine._state;
    gl.bindVertexArray(vao.handle);
    s.boundVao = vao.handle;
    for (const b of vao._bindings) {
        bindArrayBufferRaw(engine, b.buffer.handle);
        for (const a of b.attrs) {
            gl.enableVertexAttribArray(a.loc);
            gl.vertexAttribPointer(a.loc, a.size, a.type, a.normalized, a.stride, a.offset);
            gl.vertexAttribDivisor(a.loc, a.divisor);
        }
    }
    gl.bindBuffer(ELEMENT_ARRAY_BUFFER, vao._indexBuffer.handle);
    gl.bindVertexArray(null);
    s.boundVao = null;
    s.boundElementBuffer = null;
}

/* ────────────────────────────  internal helpers  ──────────────────────────── */

/** Bind the default (null) VAO if not already bound. The mesh path lives here so
 *  it never disturbs the quad / sprite VAO state. Binding a VAO restores ITS
 *  element-array binding, so the element-buffer cache is forgotten on the
 *  switch (the next `bindIndexBuffer` re-binds). */
function bindDefaultVao(engine: GLEngineContext): void {
    const s = engine._state;
    if (s.boundVao !== null) {
        engine.gl.bindVertexArray(null);
        s.boundVao = null;
        s.boundElementBuffer = null;
    }
}

/** Cached `gl.bindBuffer(ARRAY_BUFFER, …)`. ARRAY_BUFFER binding is global (not
 *  VAO state), so this cache is coherent across VAO switches. */
function bindArrayBufferRaw(engine: GLEngineContext, handle: WebGLBuffer): void {
    const s = engine._state;
    if (s.boundArrayBuffer === handle) {
        return;
    }
    engine.gl.bindBuffer(ARRAY_BUFFER, handle);
    s.boundArrayBuffer = handle;
}
