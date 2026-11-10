/**
 * Native GL-state cache — the native-backend twin of `state.ts`. Same
 * compare-and-elide model (eager bindings + deferred render-state packed in a
 * `Float64Array`), so the native higher-level modules mirror their WebGL
 * counterparts one-to-one; only the flushed device calls differ (native
 * command-stream writes instead of `gl.*`).
 *
 * This is a deliberate copy rather than a shared import: the WebGL `state.ts`
 * must stay byte-identical in the WebGL bundle, so the native backend keeps its
 * own decoupled copy (see docs/gl/architecture/00-lite-gl.md §backends).
 *
 * Handles are opaque {@link NativeData} (uint32 blocks) rather than `WebGL*`
 * objects; referential identity is still what the eager cache compares.
 */
import type { NativeData, NativeProgram, NativeUniform } from "./native-types.js";
import type { GLEngineContext } from "./native-context.js";

/* ─── Deferred render-state index-array layout (mirrors state.ts) ───────────── */
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
/** @internal Offset from an ACTUAL slot to its DESIRED twin. */
export const RS_DESIRED = 21;
/** @internal */ export const RS_CLEAR_R = 42;
/** @internal */ export const RS_CLEAR_G = 43;
/** @internal */ export const RS_CLEAR_B = 44;
/** @internal */ export const RS_CLEAR_A = 45;

/**
 * Native GL-state cache. Owned by `GLEngineContext._state`. See `state.ts`
 * for the full description of the eager / deferred split — the semantics are
 * identical; only the handle types and the flushed device calls differ.
 */
export interface NativeGLState {
    /** Currently-set native program, or null. */
    currentProgram: NativeProgram | null;
    /** Sampler handles of the current program indexed by emulated texture unit
     *  (native binds textures to sampler uniforms, not units), or null. */
    currentSamplers: (NativeUniform | null)[] | null;
    /** Active texture unit index. */
    activeTextureUnit: number;
    /** Per-unit texture binding; length === caps.maxTextureUnits. */
    boundTextures: (NativeData | null)[];
    /** Bound array buffer (native handle), or null. */
    boundArrayBuffer: NativeData | null;
    /** Bound element buffer (native handle), or null. */
    boundElementBuffer: NativeData | null;
    /** Bound vertex array (native handle), or null. */
    boundVao: NativeData | null;
    /** Cached viewport X. */
    viewportX: number;
    /** Cached viewport Y. */
    viewportY: number;
    /** Cached viewport width. */
    viewportW: number;
    /** Cached viewport height. */
    viewportH: number;
    /** Currently-bound draw framebuffer (native handle), or null for the backbuffer. */
    boundFramebuffer: NativeData | null;
    /** Deferred render-state (blend/depth/cull/stencil/color-mask), packed into
     *  one `Float64Array(46)`. See `state.ts` for the slot layout + sentinels. */
    rs: Float64Array;
    /** True when a deferred-state setter ran since the last flush. */
    statesDirty: boolean;
    /** DESIRED native blend preset (`_native.Engine.ALPHA_*`), or `-1` unset.
     *  Native (bgfx) only exposes preset blend modes via `COMMAND_SETBLENDMODE`,
     *  not the separate src/dst/equation funcs the WebGL `rs` slots carry, so the
     *  native blend module tracks a single preset here instead. */
    blendModeDesired: number;
    /** ACTUAL applied native blend preset, or `-1` unset. */
    blendModeActual: number;
    /** @internal Blend reconciler. */
    _flushBlend?: (engine: GLEngineContext) => void;
    /** @internal Depth + cull reconciler. */
    _flushDepthCull?: (engine: GLEngineContext) => void;
    /** @internal Stencil reconciler. */
    _flushStencil?: (engine: GLEngineContext) => void;
    /** @internal Color-write-mask reconciler. */
    _flushColorMask?: (engine: GLEngineContext) => void;
    /** @internal DESIRED back-face stencil ops `[fail, zFail, zPass]` (`-1` =
     *  KEEP), present once `setStencilOpSeparate` targeted a single face. The
     *  front ops live in the shared `rs` slots; Native has one stencil op set, so
     *  the stencil reconciler throws while the two differ. */
    _stencilBackOps?: number[];
    /** Scissor-test enable tri-state (`-1` unset, `0` off, `1` on). */
    scissorEnabled: number;
    /** Cached scissor X. */
    scissorX: number;
    /** Cached scissor Y. */
    scissorY: number;
    /** Cached scissor width. */
    scissorW: number;
    /** Cached scissor height. */
    scissorH: number;
    /** Per-location attribute-enable flags for the default VAO (mesh path). */
    enabledAttribs: boolean[];
    /** Attribute locations currently configured with a non-default instance divisor. */
    instanceLocations: number[];
    /** Shared fullscreen quad — lazily created on first `applyEffectWrapper`. */
    quadVbo: NativeData | null;
    /** Shared fullscreen quad index buffer. */
    quadIbo: NativeData | null;
    /** Shared fullscreen quad VAO. */
    quadVao: NativeData | null;
}

/** Write the `-1` unset sentinels into both halves of the `rs` array. */
function applyRenderStateSentinels(rs: Float64Array): void {
    // Depth func / stencil func / stencil ops use -1 for "GL default" (LESS /
    // ALWAYS / KEEP) — 0 would be a real enum (GL_ZERO).
    for (const i of [
        RS_BLEND_ENABLED,
        RS_DEPTH_TEST,
        RS_DEPTH_MASK,
        RS_DEPTH_FUNC,
        RS_CULL_ENABLED,
        RS_STENCIL_TEST,
        RS_STENCIL_MASK,
        RS_STENCIL_FUNC_FUNC,
        RS_STENCIL_OP_FAIL,
        RS_STENCIL_OP_ZFAIL,
        RS_STENCIL_OP_ZPASS,
        RS_COLOR_MASK,
    ]) {
        rs[i] = -1;
        rs[i + RS_DESIRED] = -1;
    }
    rs[RS_CLEAR_R] = rs[RS_CLEAR_G] = rs[RS_CLEAR_B] = rs[RS_CLEAR_A] = -1;
}

/** Allocate the 46-slot deferred render-state array with its unset sentinels. */
function createRenderStateArray(): Float64Array {
    const rs = new Float64Array(46);
    applyRenderStateSentinels(rs);
    return rs;
}

/** Re-initialise a live render-state array in place. */
function resetRenderStateArray(rs: Float64Array): void {
    rs.fill(0);
    applyRenderStateSentinels(rs);
}

/** Allocate a fresh, fully-null native state sized for `maxTextureUnits`. */
export function createNativeGLState(maxTextureUnits: number): NativeGLState {
    return {
        currentProgram: null,
        currentSamplers: null,
        activeTextureUnit: 0,
        boundTextures: new Array<NativeData | null>(maxTextureUnits).fill(null),
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
        blendModeDesired: -1,
        blendModeActual: -1,
        scissorEnabled: -1,
        scissorX: 0,
        scissorY: 0,
        scissorW: 0,
        scissorH: 0,
        enabledAttribs: [],
        instanceLocations: [],
        quadVbo: null,
        quadIbo: null,
        quadVao: null,
    };
}

/** Reset only the cached "current state" (bindings + render-state), preserving
 *  the shared quad's GPU handles. */
export function resetNativeGLStateCache(state: NativeGLState): void {
    state.currentProgram = null;
    state.currentSamplers = null;
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
    state.blendModeDesired = -1;
    state.blendModeActual = -1;
    state.scissorEnabled = -1;
    state.scissorX = 0;
    state.scissorY = 0;
    state.scissorW = 0;
    state.scissorH = 0;
    state.enabledAttribs.length = 0;
    state.instanceLocations.length = 0;
    state._stencilBackOps = undefined;
}

/** Zero the cache in-place, including the shared quad handles (device-lost). */
export function resetNativeGLState(state: NativeGLState): void {
    resetNativeGLStateCache(state);
    state.quadVbo = null;
    state.quadIbo = null;
    state.quadVao = null;
}
