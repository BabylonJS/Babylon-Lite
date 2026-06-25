import type { GLEngineContext } from "./context.js";

/* ─── Deferred render-state index-array layout ────────────────────────────────
 * The deferred render-state (blend / depth / cull / stencil / color-mask) lives
 * in a single flat `Float64Array(46)` on `GLState.rs`: slots `0..20` hold the
 * ACTUAL applied GL state, slots `21..41` (`RS_X + RS_DESIRED`) the DESIRED twin,
 * and slots `42..45` the standalone (no-desired-twin) cached `gl.clearColor` RGBA.
 *
 * These `@internal` index consts are imported by blend.ts / depth-stencil.ts /
 * apply-states.ts. Because they are plain `const` integers, esbuild inlines each
 * to a 1–2 char literal (`rs[RS_BLEND_SRC_RGB + RS_DESIRED]` → `rs[22]`) when
 * bundling a scene — far smaller than the old cross-module `.dBlendSrcRGB` named
 * props, which could not be mangled and shipped verbatim in every bundle.
 *
 * Float64Array (NOT Int32Array) is required: `RS_STENCIL_MASK` /
 * `RS_STENCIL_FUNC_MASK` can be `0xFFFFFFFF`, which Int32 would store as `-1` and
 * collide with the `-1` "unset" sentinel; Float64 keeps `4294967295` distinct. */
/** @internal */ export const RS_BLEND_ENABLED = 0;
/** @internal */ export const RS_BLEND_SRC_RGB = 1;
/** @internal */ export const RS_BLEND_DST_RGB = 2;
/** @internal */ export const RS_BLEND_SRC_A = 3;
/** @internal */ export const RS_BLEND_DST_A = 4;
/** @internal */ export const RS_BLEND_EQ_RGB = 5;
/** @internal */ export const RS_BLEND_EQ_A = 6;
/** @internal */ export const RS_DEPTH_TEST = 7;
/** @internal */ export const RS_DEPTH_MASK = 8;
/** @internal */ export const RS_DEPTH_FUNC = 9;
/** @internal */ export const RS_CULL_ENABLED = 10;
/** @internal */ export const RS_CULL_FACE = 11;
/** @internal */ export const RS_STENCIL_TEST = 12;
/** @internal */ export const RS_STENCIL_MASK = 13;
/** @internal */ export const RS_STENCIL_FUNC_FUNC = 14;
/** @internal */ export const RS_STENCIL_FUNC_REF = 15;
/** @internal */ export const RS_STENCIL_FUNC_MASK = 16;
/** @internal */ export const RS_STENCIL_OP_FAIL = 17;
/** @internal */ export const RS_STENCIL_OP_ZFAIL = 18;
/** @internal */ export const RS_STENCIL_OP_ZPASS = 19;
/** @internal */ export const RS_COLOR_MASK = 20;
/** @internal Offset from an ACTUAL slot (`0..20`) to its DESIRED twin (`21..41`). */
export const RS_DESIRED = 21;
/* Standalone cached gl.clearColor RGBA slots (`42..45`) — NO desired twin; a
 * simple apply-on-clear cache like viewport/scissor, stored in `rs` (not as named
 * GLState fields) so the index access mangles small instead of shipping
 * `.clearColorR` verbatim in every bundle. */
/** @internal */ export const RS_CLEAR_R = 42;
/** @internal */ export const RS_CLEAR_G = 43;
/** @internal */ export const RS_CLEAR_B = 44;
/** @internal */ export const RS_CLEAR_A = 45;

/**
 * GL-state cache type. Owned by `GLEngineContext._state`.
 *
 * Two flavours of cached state coexist here:
 *
 *  - **Eager bindings** (program / buffers / textures / VAO / framebuffer /
 *    viewport / scissor / unpack). Each binding setter issues its `gl.*` call
 *    immediately and updates the matching field in lock-step, eliding the call
 *    when the cache already matches.
 *  - **Deferred render-state** (blend / depth / cull / stencil / color-mask),
 *    stored in the {@link GLState.rs} index-array. These follow Babylon's
 *    `applyStates()` model: each setter records only the DESIRED slot
 *    (`rs[RS_X + RS_DESIRED]`) and sets `statesDirty`; the real `gl.*` calls are
 *    flushed by {@link applyGLStates} (apply-states.ts) immediately before each
 *    draw / clear, reconciling DESIRED → ACTUAL and writing the actual slots
 *    (`rs[RS_X]`) in lock-step. Both halves keep their `-1`/`0` unset sentinels.
 *
 * See `00-lite-gl.md` §4 for the full table of cached operations and the
 * deferred-state flush sites.
 *
 * INVARIANTS:
 *  - The cache is the source of truth. If consumers poke `engine.gl.*` directly
 *    they will silently corrupt this state.
 *  - On `webglcontextlost` the whole `rs` array (both the actual and desired
 *    halves) is reset to its initial sentinels (handles are dead anyway;
 *    subsequent setters bail out on `engine._isLost`, and a post-restore setter
 *    re-marks `statesDirty`).
 */
export interface GLState {
    currentProgram: WebGLProgram | null;
    activeTextureUnit: number;
    /** Per-unit binding; length === caps.maxTextureUnits. */
    boundTextures: (WebGLTexture | null)[];
    boundArrayBuffer: WebGLBuffer | null;
    boundElementBuffer: WebGLBuffer | null;
    boundVao: WebGLVertexArrayObject | null;
    viewportX: number;
    viewportY: number;
    viewportW: number;
    viewportH: number;
    /**
     * Currently-bound draw framebuffer, or `null` for the default (canvas)
     * framebuffer. Owned by the render-target module's `bindRenderTarget`
     * (binding `null` returns to the canvas). Reset to `null` on context-lost.
     */
    boundFramebuffer: WebGLFramebuffer | null;
    /**
     * Deferred render-state (blend / depth / cull / stencil / color-mask) packed
     * into ONE flat `Float64Array(46)`. Slots `0..20` (indexed by the `RS_*`
     * consts) are the ACTUAL applied GL state — what {@link applyGLStates} last
     * wrote to the context; slots `21..41` (`rs[RS_X + RS_DESIRED]`) are the
     * DESIRED twin the setters record. The setters write ONLY the desired half
     * (never `gl.*`, never the actual half) and raise `statesDirty`;
     * `applyGLStates` reconciles each desired → its actual twin right before a
     * draw / clear, issuing only the GL calls that changed and updating the
     * actual half in lock-step. Both preset and arbitrary blend paths feed the
     * same desired slots, so they can never desync.
     *
     * Sentinels (identical for both halves): `-1` for the tri-state enables
     * (`RS_BLEND_ENABLED` / `RS_DEPTH_TEST` / `RS_DEPTH_MASK` / `RS_CULL_ENABLED`
     * / `RS_STENCIL_TEST`) and the mask caches (`RS_STENCIL_MASK` /
     * `RS_COLOR_MASK`); `0` for every func / equation / op / ref slot (no GL enum
     * is `0`). An unset desired equals its unset actual and is never flushed; the
     * `-1` blend/test sentinels guarantee the first applied state is never elided.
     * The blend func/equation slots are only trusted while `RS_BLEND_ENABLED` is
     * `1` — the disabled→enabled transition re-issues both (matching Babylon's
     * `AlphaState`, which does not track them while blending is off).
     *
     * Float64 (not Int32): `RS_STENCIL_MASK` / `RS_STENCIL_FUNC_MASK` can be
     * `0xFFFFFFFF`, which Int32 stores as `-1` — colliding with the `-1` unset
     * sentinel. Reset on context-lost. */
    rs: Float64Array;
    /** `true` when at least one deferred-state setter ran since the last
     *  {@link applyGLStates}. Gates the flush so an unchanged frame issues no
     *  reconciliation work. */
    statesDirty: boolean;
    /* ─── Deferred render-state appliers (per-category, lazily installed) ──────
     * Each category's reconciler (blend / depth+cull / stencil / color-mask) is
     * installed onto its slot the first time the matching setter runs — a runtime
     * assignment, NOT a module-level side effect. `applyGLStates` dispatches ONLY
     * through these slots, so the reconcilers (and their GL reconciliation code)
     * are reachable only when their setter is in the bundle: a scene that never
     * touches a category tree-shakes its reconciler out entirely (e.g. a clear-
     * only scene drops all four). Left undefined until installed; never cleared on
     * context-lost (a post-restore setter re-installs idempotently). */
    /** @internal Blend reconciler (Babylon's `_alphaState`). */
    _flushBlend?: (engine: GLEngineContext) => void;
    /** @internal Depth + cull reconciler (Babylon's `_depthCullingState`). */
    _flushDepthCull?: (engine: GLEngineContext) => void;
    /** @internal Stencil reconciler (Babylon's `_stencilState`). */
    _flushStencil?: (engine: GLEngineContext) => void;
    /** @internal Color-write-mask reconciler (Babylon's `setColorWrite`). */
    _flushColorMask?: (engine: GLEngineContext) => void;
    /** Scissor-test enable tri-state (`-1` unset, `0` off, `1` on). */
    scissorEnabled: number;
    scissorX: number;
    scissorY: number;
    scissorW: number;
    scissorH: number;
    /** Cached `gl.pixelStorei(UNPACK_ALIGNMENT)`, or `-1` when unset. */
    unpackAlignment: number;
    /** Cached `gl.pixelStorei(UNPACK_FLIP_Y_WEBGL)`, or `-1` when unset. */
    unpackFlipY: number;
    /** Cached `gl.pixelStorei(UNPACK_PREMULTIPLY_ALPHA_WEBGL)`, or `-1` unset. */
    unpackPremultiplyAlpha: number;
    /**
     * Per-location vertex-attribute enable flags for the DEFAULT (null) VAO —
     * the mesh / instancing path (mirrors Babylon's `_vertexAttribArraysEnabled`).
     * Index is the attribute location. lite-gl's quad / sprite paths use their
     * own VAOs and do not touch this. Cleared on context-lost.
     */
    enabledAttribs: boolean[];
    /**
     * Attribute locations currently configured with a non-default vertex divisor
     * (instanced attributes), mirroring Babylon's `_currentInstanceLocations`.
     * `unbindInstanceAttributes` resets each back to divisor 0 and clears this.
     */
    instanceLocations: number[];
    /** Shared fullscreen quad — lazily created on first `applyEffectWrapper`. */
    quadVbo: WebGLBuffer | null;
    quadIbo: WebGLBuffer | null;
    quadVao: WebGLVertexArrayObject | null;
}

/** Indices in `rs` whose unset sentinel is `-1` (the tri-state enables + the
 *  `stencilMask` / `colorMask` caches). Every other slot defaults to `0`. The
 *  sentinel is written to BOTH the actual (`i`) and desired (`i + RS_DESIRED`)
 *  halves. Kept as a function-local literal so it stays a runtime value (no
 *  module-level allocation / side effect). */
function applyRenderStateSentinels(rs: Float64Array): void {
    for (const i of [RS_BLEND_ENABLED, RS_DEPTH_TEST, RS_DEPTH_MASK, RS_CULL_ENABLED, RS_STENCIL_TEST, RS_STENCIL_MASK, RS_COLOR_MASK]) {
        rs[i] = -1;
        rs[i + RS_DESIRED] = -1;
    }
    // clearColor RGBA (standalone, no DESIRED twin) — `-1` forces the first clear
    // to issue gl.clearColor (valid components are 0..1).
    rs[RS_CLEAR_R] = rs[RS_CLEAR_G] = rs[RS_CLEAR_B] = rs[RS_CLEAR_A] = -1;
}

/** Allocate the 46-slot deferred render-state array (21 actual + 21 desired + 4
 *  standalone clearColor) initialised to its unset sentinels — a fresh
 *  `Float64Array` is already all `0`, so only the `-1` slots need writing. */
function createRenderStateArray(): Float64Array {
    const rs = new Float64Array(46);
    applyRenderStateSentinels(rs);
    return rs;
}

/** Re-initialise a live render-state array in place: zero every slot, then
 *  restore the `-1` sentinels. */
function resetRenderStateArray(rs: Float64Array): void {
    rs.fill(0);
    applyRenderStateSentinels(rs);
}

/** Allocate a fresh, fully-null GLState sized for `maxTextureUnits`. */
export function createGLState(maxTextureUnits: number): GLState {
    return {
        currentProgram: null,
        activeTextureUnit: 0,
        boundTextures: new Array<WebGLTexture | null>(maxTextureUnits).fill(null),
        boundArrayBuffer: null,
        boundElementBuffer: null,
        boundVao: null,
        viewportX: 0,
        viewportY: 0,
        viewportW: 0,
        viewportH: 0,
        boundFramebuffer: null,
        rs: createRenderStateArray(),
        statesDirty: false,
        scissorEnabled: -1,
        scissorX: 0,
        scissorY: 0,
        scissorW: 0,
        scissorH: 0,
        unpackAlignment: -1,
        unpackFlipY: -1,
        unpackPremultiplyAlpha: -1,
        enabledAttribs: [],
        instanceLocations: [],
        quadVbo: null,
        quadIbo: null,
        quadVao: null,
    };
}

/** Reset only the cached "current GL state" — every binding (program / buffers /
 *  textures / VAO / framebuffer) and render-state (blend / depth / stencil /
 *  scissor / color-mask / viewport / unpack) field, including the whole `rs`
 *  deferred render-state array (BOTH the actual applied values and the DESIRED
 *  twins) plus `statesDirty` — to its unset sentinel, WITHOUT discarding owned
 *  GPU resources (the shared quad). After this, the next setter in each category
 *  is re-issued rather than elided.
 *
 *  Used by `resetGLState` (context-lost) and by `wipeGLStateCache` (a host that
 *  shares the GL context calling in after mutating raw `gl.*` state). The shared
 *  quad's GL objects are still alive in the latter case, so they are preserved
 *  here to avoid leaking + needlessly rebuilding them every render scope. */
export function resetGLStateCache(state: GLState): void {
    state.currentProgram = null;
    state.activeTextureUnit = 0;
    state.boundTextures.fill(null);
    state.boundArrayBuffer = null;
    state.boundElementBuffer = null;
    state.boundVao = null;
    state.viewportX = 0;
    state.viewportY = 0;
    state.viewportW = 0;
    state.viewportH = 0;
    state.boundFramebuffer = null;
    resetRenderStateArray(state.rs);
    state.statesDirty = false;
    state.scissorEnabled = -1;
    state.scissorX = 0;
    state.scissorY = 0;
    state.scissorW = 0;
    state.scissorH = 0;
    state.unpackAlignment = -1;
    state.unpackFlipY = -1;
    state.unpackPremultiplyAlpha = -1;
    state.enabledAttribs.length = 0;
    state.instanceLocations.length = 0;
}

/** Zero the cache in-place. Used by the context-lost handler — GL handles are
 *  already dead per WebGL spec; we forget what we knew about them (including the
 *  shared quad, whose GL objects are gone and must be rebuilt) so the next
 *  bind/use after restore is NOT incorrectly elided. */
export function resetGLState(state: GLState): void {
    resetGLStateCache(state);
    state.quadVbo = null;
    state.quadIbo = null;
    state.quadVao = null;
}
