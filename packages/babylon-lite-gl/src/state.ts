/**
 * GL-state cache type. Owned by `GLEngineContext._state`. Source of truth for
 * "what is currently bound on the GL context" — every public function that
 * issues a GL call updates this in lock-step with the underlying gl.* call,
 * and elides the call when the cached state already matches the requested one.
 *
 * See `00-lite-gl.md` §4.1 for the full table of cached operations.
 *
 * INVARIANTS:
 *  - The cache is the source of truth. If consumers poke `engine.gl.*` directly
 *    they will silently corrupt this state.
 *  - On `webglcontextlost` the entire cache is reset to its initial values
 *    (handles are dead anyway; subsequent setters bail out on `engine._isLost`).
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
     * Cached blend mode — a `GLBlendMode` numeric value, or `-1` when unset
     * (no `gl.enable/disable(BLEND)` issued yet). `setBlendMode` elides the
     * `gl.enable/disable(BLEND)` + `gl.blendFuncSeparate` calls when the
     * requested mode already matches. Reset to `-1` on context-lost.
     */
    blendMode: number;
    /** Shared fullscreen quad — lazily created on first `applyEffectWrapper`. */
    quadVbo: WebGLBuffer | null;
    quadIbo: WebGLBuffer | null;
    quadVao: WebGLVertexArrayObject | null;
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
        blendMode: -1,
        quadVbo: null,
        quadIbo: null,
        quadVao: null,
    };
}

/** Zero the cache in-place. Used by the context-lost handler — GL handles are
 *  already dead per WebGL spec; we only need to forget what we knew about them
 *  so the next bind/use after restore is NOT incorrectly elided. */
export function resetGLState(state: GLState): void {
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
    state.blendMode = -1;
    state.quadVbo = null;
    state.quadIbo = null;
    state.quadVao = null;
}
