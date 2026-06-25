/**
 * Depth, stencil, color-mask and clear state — the lite-gl counterpart of
 * Babylon's `_depthCullingState` / `_stencilState` / `setColorWrite` / `clear`.
 *
 * Like Babylon, these setters are DEFERRED: they buffer the requested values
 * into the DESIRED (`d*`) mirror fields of `GLState` and raise `statesDirty`,
 * issuing NO `gl.*` calls themselves. `applyGLStates` (apply-states.ts) flushes
 * the diff to GL right before each draw (and before `clearEngine`'s `gl.clear`,
 * since a clear respects the current write masks). Every field is reconciled
 * independently, so a flush that changes only one sub-state (e.g. just the
 * stencil op triple) issues only that GL call. Omitted setter fields leave the
 * corresponding desired value untouched (merge-from-desired).
 *
 * All setters are no-ops on a lost/disposed context.
 *
 * This module also hosts {@link generateRenderTargetStencil} — the tree-shakeable
 * opt-in that gives a `/render-target` {@link GLRenderTarget} a stencil (or packed
 * depth+stencil) attachment. Keeping the STENCIL_INDEX8 / DEPTH24_STENCIL8
 * renderbuffer code here (rather than in the render-target core) means a consumer
 * that only needs a depth buffer never ships it. The one-way type import below
 * (`depth-stencil` importing `render-target`) introduces NO cycle: render-target
 * must not import this module.
 */
import type { GLEngineContext } from "./context.js";
import type { GLRenderTarget } from "./render-target.js";
import { applyGLStates } from "./apply-states.js";
import {
    RS_CLEAR_A,
    RS_CLEAR_B,
    RS_CLEAR_G,
    RS_CLEAR_R,
    RS_COLOR_MASK,
    RS_CULL_ENABLED,
    RS_CULL_FACE,
    RS_DEPTH_FUNC,
    RS_DEPTH_MASK,
    RS_DEPTH_TEST,
    RS_DESIRED,
    RS_STENCIL_FUNC_FUNC,
    RS_STENCIL_FUNC_MASK,
    RS_STENCIL_FUNC_REF,
    RS_STENCIL_MASK,
    RS_STENCIL_OP_FAIL,
    RS_STENCIL_OP_ZFAIL,
    RS_STENCIL_OP_ZPASS,
    RS_STENCIL_TEST,
} from "./state.js";

// ── Clear bits (used by `clearEngine`).
/** GL clear bits. */
const COLOR_BUFFER_BIT = 0x4000;
const DEPTH_BUFFER_BIT = 0x0100;
const STENCIL_BUFFER_BIT = 0x0400;

// ── Test-enable enums for the per-category reconcilers below.
/** GL `gl.DEPTH_TEST`. */
const DEPTH_TEST = 0x0b71;
/** GL `gl.CULL_FACE`. */
const CULL_FACE = 0x0b44;
/** GL `gl.STENCIL_TEST`. */
const STENCIL_TEST = 0x0b90;

// ── Framebuffer / renderbuffer enums (used only by generateRenderTargetStencil).
// Module-local consts mirror render-target.ts's constant style. Because the
// render-target core no longer references the stencil/packed enums, they live
// here and tree-shake away for consumers that never opt into a stencil buffer.
/** GL `gl.FRAMEBUFFER`. */
const FRAMEBUFFER = 0x8d40;
/** GL `gl.RENDERBUFFER`. */
const RENDERBUFFER = 0x8d41;
/** GL `gl.DEPTH24_STENCIL8` — packed depth+stencil sized format. */
const DEPTH24_STENCIL8 = 0x88f0;
/** GL `gl.STENCIL_INDEX8` — stencil-only sized format. */
const STENCIL_INDEX8 = 0x8d48;
/** GL `gl.DEPTH_STENCIL_ATTACHMENT`. */
const DEPTH_STENCIL_ATTACHMENT = 0x821a;
/** GL `gl.STENCIL_ATTACHMENT`. */
const STENCIL_ATTACHMENT = 0x8d20;
/** GL `gl.DEPTH_ATTACHMENT` — where the render-target core attaches its depth-only
 *  renderbuffer (re-established when rolling back a failed stencil attach). */
const DEPTH_ATTACHMENT = 0x8d00;
/** GL `gl.FRAMEBUFFER_COMPLETE`. */
const FRAMEBUFFER_COMPLETE = 0x8cd5;

/** Depth-buffer configuration for {@link setDepthState}. Omitted fields are
 *  left unchanged. */
export interface GLDepthState {
    /** Enable/disable the depth test (`gl.enable/disable(DEPTH_TEST)`). */
    test?: boolean;
    /** Enable/disable depth writes (`gl.depthMask`). */
    write?: boolean;
    /** Depth comparison function (`gl.depthFunc`), e.g. `gl.LESS`. */
    func?: GLenum;
}

/** Stencil configuration for {@link setStencilState}. Omitted fields are left
 *  unchanged. The `func`/`ref`/`funcMask` triple and the
 *  `opFail`/`opZFail`/`opZPass` triple are each applied as a unit (any member
 *  present re-issues that GL call, merging the unspecified members from cache). */
export interface GLStencilState {
    /** Enable/disable the stencil test (`gl.enable/disable(STENCIL_TEST)`). */
    test?: boolean;
    /** Stencil write mask (`gl.stencilMask`). */
    mask?: number;
    /** Comparison function (`gl.stencilFunc` arg 1), e.g. `gl.ALWAYS`. */
    func?: GLenum;
    /** Reference value (`gl.stencilFunc` arg 2). */
    ref?: number;
    /** Comparison mask (`gl.stencilFunc` arg 3). */
    funcMask?: number;
    /** Op when the stencil test fails (`gl.stencilOp` arg 1). */
    opFail?: GLenum;
    /** Op when the stencil test passes but depth fails (`gl.stencilOp` arg 2). */
    opZFail?: GLenum;
    /** Op when both stencil and depth pass (`gl.stencilOp` arg 3). */
    opZPass?: GLenum;
}

/** Options for {@link clearEngine}. */
export interface GLClearOptions {
    /** When set, clears the color buffer to this RGBA color (alpha default 1). */
    color?: { r: number; g: number; b: number; a?: number };
    /** Clear the depth buffer (respects the current depth write mask). */
    depth?: boolean;
    /** Clear the stencil buffer (respects the current stencil write mask). */
    stencil?: boolean;
}

/**
 * Buffer depth-buffer state (test enable, write mask, comparison function) into
 * the DESIRED state — the lite-gl equivalent of mutating Babylon's
 * `engine.depthCullingState.{depthTest,depthMask,depthFunc}`. Flushed to GL by
 * `applyGLStates` before the next draw / clear; omitted fields are untouched.
 *
 * @param engine - The engine.
 * @param state - The depth fields to change. Omitted fields are untouched.
 */
export function setDepthState(engine: GLEngineContext, state: GLDepthState): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const s = engine._state;
    if (state.test !== undefined) {
        s.rs[RS_DEPTH_TEST + RS_DESIRED] = state.test ? 1 : 0;
    }
    if (state.write !== undefined) {
        s.rs[RS_DEPTH_MASK + RS_DESIRED] = state.write ? 1 : 0;
    }
    if (state.func !== undefined) {
        s.rs[RS_DEPTH_FUNC + RS_DESIRED] = state.func;
    }
    s._flushDepthCull = flushDepthCull;
    s.statesDirty = true;
}

/**
 * Enable/disable face culling and (optionally) set the cull face — the lite-gl
 * equivalent of `engine.depthCullingState.cull` + `cullFace`.
 *
 * @param engine - The engine.
 * @param enabled - Enable (`true`) or disable (`false`) `gl.CULL_FACE`.
 * @param face - Optional cull face (`gl.BACK` / `gl.FRONT` / `gl.FRONT_AND_BACK`).
 */
export function setCullState(engine: GLEngineContext, enabled: boolean, face?: GLenum): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const s = engine._state;
    s.rs[RS_CULL_ENABLED + RS_DESIRED] = enabled ? 1 : 0;
    if (face !== undefined) {
        s.rs[RS_CULL_FACE + RS_DESIRED] = face;
    }
    s._flushDepthCull = flushDepthCull;
    s.statesDirty = true;
}

/**
 * Buffer stencil state (test enable, write mask, comparison func triple, op
 * triple) into the DESIRED state — the lite-gl equivalent of mutating Babylon's
 * `engine.stencilState.*`. Flushed by `applyGLStates` before the next draw /
 * clear; omitted fields are untouched (merge-from-desired).
 *
 * @param engine - The engine.
 * @param state - The stencil fields to change. Omitted fields are untouched.
 */
export function setStencilState(engine: GLEngineContext, state: GLStencilState): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const s = engine._state;
    if (state.test !== undefined) {
        s.rs[RS_STENCIL_TEST + RS_DESIRED] = state.test ? 1 : 0;
    }
    if (state.mask !== undefined) {
        s.rs[RS_STENCIL_MASK + RS_DESIRED] = state.mask;
    }
    if (state.func !== undefined) {
        s.rs[RS_STENCIL_FUNC_FUNC + RS_DESIRED] = state.func;
    }
    if (state.ref !== undefined) {
        s.rs[RS_STENCIL_FUNC_REF + RS_DESIRED] = state.ref;
    }
    if (state.funcMask !== undefined) {
        s.rs[RS_STENCIL_FUNC_MASK + RS_DESIRED] = state.funcMask;
    }
    if (state.opFail !== undefined) {
        s.rs[RS_STENCIL_OP_FAIL + RS_DESIRED] = state.opFail;
    }
    if (state.opZFail !== undefined) {
        s.rs[RS_STENCIL_OP_ZFAIL + RS_DESIRED] = state.opZFail;
    }
    if (state.opZPass !== undefined) {
        s.rs[RS_STENCIL_OP_ZPASS + RS_DESIRED] = state.opZPass;
    }
    s._flushStencil = flushStencil;
    s.statesDirty = true;
}

/**
 * Buffer the color write mask into the DESIRED state — the lite-gl equivalent of
 * Babylon's `setColorWrite` (which passes the same flag to all four channels).
 * Flushed to GL (`gl.colorMask`) by `applyGLStates` before the next draw /
 * clear.
 *
 * @param engine - The engine.
 * @param r - Write red.
 * @param g - Write green.
 * @param b - Write blue.
 * @param a - Write alpha.
 */
export function setColorMask(engine: GLEngineContext, r: boolean, g: boolean, b: boolean, a: boolean): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const packed = (r ? 8 : 0) | (g ? 4 : 0) | (b ? 2 : 0) | (a ? 1 : 0);
    const s = engine._state;
    s.rs[RS_COLOR_MASK + RS_DESIRED] = packed;
    s._flushColorMask = flushColorMask;
    s.statesDirty = true;
}

/**
 * Clear the currently-bound framebuffer's color / depth / stencil buffers — the
 * lite-gl equivalent of Babylon's `clear(color, backBuffer, depth, stencil)`.
 * Depth/stencil clears respect the current write masks (set them first via
 * {@link setDepthState} / {@link setStencilState}). No-op when nothing is
 * requested or the context is lost/disposed.
 *
 * @param engine - The engine.
 * @param options - Which buffers to clear (and the color value).
 */
export function clearEngine(engine: GLEngineContext, options: GLClearOptions): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const gl = engine.gl;
    let mask = 0;
    if (options.color !== undefined) {
        const c = options.color;
        const a = c.a ?? 1;
        const rs = engine._state.rs;
        // Cached: gl.clearColor is per-context state GL retains, so only re-issue
        // it when the requested color actually changes (Babylon re-sets it every
        // clear; this elides the redundant JS↔native call for constant backgrounds).
        if (rs[RS_CLEAR_R] !== c.r || rs[RS_CLEAR_G] !== c.g || rs[RS_CLEAR_B] !== c.b || rs[RS_CLEAR_A] !== a) {
            gl.clearColor(c.r, c.g, c.b, a);
            rs[RS_CLEAR_R] = c.r;
            rs[RS_CLEAR_G] = c.g;
            rs[RS_CLEAR_B] = c.b;
            rs[RS_CLEAR_A] = a;
        }
        mask |= COLOR_BUFFER_BIT;
    }
    if (options.depth === true) {
        mask |= DEPTH_BUFFER_BIT;
    }
    if (options.stencil === true) {
        mask |= STENCIL_BUFFER_BIT;
    }
    if (mask !== 0) {
        // Babylon parity: a clear respects the current depth/stencil/color write
        // masks, so flush any deferred state before clearing.
        applyGLStates(engine);
        gl.clear(mask);
    }
}

/* ───────────────────  deferred render-state reconcilers  ──────────────────────
 * The per-category half of `applyGLStates`. Each setter above installs the
 * matching reconciler onto its `_state._flush*` slot; `applyGLStates`
 * (apply-states.ts) dispatches ONLY through those slots. Co-locating them with
 * their setters makes each one reachable solely when its setter is in the bundle,
 * so a scene that never touches depth/cull, stencil, or color-mask tree-shakes
 * the corresponding reconciler — and its GL code — away entirely. Each reconciles
 * its DESIRED (`rs[RS_X + RS_DESIRED]`) slots against the ACTUAL twins (`rs[RS_X]`)
 * and issues only the `gl.*` calls that changed, in the same order and with the
 * same elision rules as the former monolithic flush. */

/** Reconcile depth + cull (Babylon's `_depthCullingState.apply`). @internal */
function flushDepthCull(engine: GLEngineContext): void {
    const gl = engine.gl;
    const rs = engine._state.rs;
    const dTest = rs[RS_DEPTH_TEST + RS_DESIRED]!;
    if (dTest !== rs[RS_DEPTH_TEST]) {
        rs[RS_DEPTH_TEST] = dTest;
        if (dTest === 1) {
            gl.enable(DEPTH_TEST);
        } else {
            gl.disable(DEPTH_TEST);
        }
    }
    const dMask = rs[RS_DEPTH_MASK + RS_DESIRED]!;
    if (dMask !== rs[RS_DEPTH_MASK]) {
        rs[RS_DEPTH_MASK] = dMask;
        gl.depthMask(dMask === 1);
    }
    const dFunc = rs[RS_DEPTH_FUNC + RS_DESIRED]!;
    if (dFunc !== rs[RS_DEPTH_FUNC]) {
        rs[RS_DEPTH_FUNC] = dFunc;
        gl.depthFunc(dFunc);
    }
    const dCull = rs[RS_CULL_ENABLED + RS_DESIRED]!;
    if (dCull !== rs[RS_CULL_ENABLED]) {
        rs[RS_CULL_ENABLED] = dCull;
        if (dCull === 1) {
            gl.enable(CULL_FACE);
        } else {
            gl.disable(CULL_FACE);
        }
    }
    const dCullFace = rs[RS_CULL_FACE + RS_DESIRED]!;
    if (dCullFace !== rs[RS_CULL_FACE]) {
        rs[RS_CULL_FACE] = dCullFace;
        gl.cullFace(dCullFace);
    }
}

/** Reconcile the stencil test / mask / func-triple / op-triple (Babylon's
 *  `_stencilState.apply`); each triple is issued as a unit. @internal */
function flushStencil(engine: GLEngineContext): void {
    const gl = engine.gl;
    const rs = engine._state.rs;
    const dTest = rs[RS_STENCIL_TEST + RS_DESIRED]!;
    if (dTest !== rs[RS_STENCIL_TEST]) {
        rs[RS_STENCIL_TEST] = dTest;
        if (dTest === 1) {
            gl.enable(STENCIL_TEST);
        } else {
            gl.disable(STENCIL_TEST);
        }
    }
    const dMask = rs[RS_STENCIL_MASK + RS_DESIRED]!;
    if (dMask !== rs[RS_STENCIL_MASK]) {
        rs[RS_STENCIL_MASK] = dMask;
        gl.stencilMask(dMask);
    }
    const dFuncFunc = rs[RS_STENCIL_FUNC_FUNC + RS_DESIRED]!;
    const dFuncRef = rs[RS_STENCIL_FUNC_REF + RS_DESIRED]!;
    const dFuncMask = rs[RS_STENCIL_FUNC_MASK + RS_DESIRED]!;
    if (dFuncFunc !== rs[RS_STENCIL_FUNC_FUNC] || dFuncRef !== rs[RS_STENCIL_FUNC_REF] || dFuncMask !== rs[RS_STENCIL_FUNC_MASK]) {
        rs[RS_STENCIL_FUNC_FUNC] = dFuncFunc;
        rs[RS_STENCIL_FUNC_REF] = dFuncRef;
        rs[RS_STENCIL_FUNC_MASK] = dFuncMask;
        gl.stencilFunc(dFuncFunc, dFuncRef, dFuncMask);
    }
    const dOpFail = rs[RS_STENCIL_OP_FAIL + RS_DESIRED]!;
    const dOpZFail = rs[RS_STENCIL_OP_ZFAIL + RS_DESIRED]!;
    const dOpZPass = rs[RS_STENCIL_OP_ZPASS + RS_DESIRED]!;
    if (dOpFail !== rs[RS_STENCIL_OP_FAIL] || dOpZFail !== rs[RS_STENCIL_OP_ZFAIL] || dOpZPass !== rs[RS_STENCIL_OP_ZPASS]) {
        rs[RS_STENCIL_OP_FAIL] = dOpFail;
        rs[RS_STENCIL_OP_ZFAIL] = dOpZFail;
        rs[RS_STENCIL_OP_ZPASS] = dOpZPass;
        gl.stencilOp(dOpFail, dOpZFail, dOpZPass);
    }
}

/** Reconcile the packed color-write mask (Babylon's `setColorWrite`). @internal */
function flushColorMask(engine: GLEngineContext): void {
    const rs = engine._state.rs;
    const dColorMask = rs[RS_COLOR_MASK + RS_DESIRED]!;
    if (dColorMask !== rs[RS_COLOR_MASK]) {
        rs[RS_COLOR_MASK] = dColorMask;
        engine.gl.colorMask((dColorMask & 8) !== 0, (dColorMask & 4) !== 0, (dColorMask & 2) !== 0, (dColorMask & 1) !== 0);
    }
}

/**
 * Opt-in: give a `/render-target` {@link GLRenderTarget} a stencil attachment,
 * replacing the core's depth-only `DEPTH_COMPONENT16` renderbuffer with either a
 * packed **`DEPTH24_STENCIL8`** buffer (default — depth *and* stencil) or a
 * stencil-only **`STENCIL_INDEX8`** buffer.
 *
 * Stencil is intentionally NOT a {@link createRenderTarget} option: keeping this
 * helper in the `/depth-stencil` sub-entry means the stencil/packed renderbuffer
 * code tree-shakes out of every bundle that only needs a color (and optional
 * depth) target.
 *
 * The attachment is **restore-correct**: it is rebuilt automatically — at the new
 * size on {@link resizeRenderTarget}, and into the fresh framebuffer after a
 * `webglcontextrestored` event — so the stencil survives for the life of the
 * target, and {@link disposeRenderTarget} releases it along with the target.
 *
 * No-op on a lost/disposed context or a disposed target.
 *
 * @param engine - The engine that owns `rt`.
 * @param rt - The render target to attach the stencil buffer to.
 * @param options - `depth` (default `true`): when `true` the attachment is a
 *  packed depth+stencil buffer (`DEPTH24_STENCIL8` on `DEPTH_STENCIL_ATTACHMENT`)
 *  — the common case, and the correct choice when the target was created with
 *  `generateDepthBuffer: true`. When `false` the attachment is stencil-only
 *  (`STENCIL_INDEX8` on `STENCIL_ATTACHMENT`).
 * @throws If a renderbuffer handle could not be allocated or the framebuffer is
 *  incomplete after attaching.
 */
export function generateRenderTargetStencil(engine: GLEngineContext, rt: GLRenderTarget, options?: { depth?: boolean }): void {
    if (engine._isLost || engine._disposed || rt._disposed) {
        return;
    }
    const packDepth = options?.depth ?? true;
    const attachment = packDepth ? DEPTH_STENCIL_ATTACHMENT : STENCIL_ATTACHMENT;
    const format = packDepth ? DEPTH24_STENCIL8 : STENCIL_INDEX8;

    const build = (e: GLEngineContext): void => {
        const gl = e.gl;
        // Capture the caller's draw target so this helper is STATE-NEUTRAL: it must
        // not silently redirect subsequent draws to `rt` (during an internal
        // rebuild `prevFb` is `rt._framebuffer`, which the core re-checks next).
        const prevFb = e._state.boundFramebuffer;
        const newRb = gl.createRenderbuffer();
        if (newRb === null) {
            throw new Error("lite-gl: gl.createRenderbuffer returned null (render target stencil)");
        }
        let committed = false;
        try {
            gl.bindFramebuffer(FRAMEBUFFER, rt._framebuffer);
            e._state.boundFramebuffer = rt._framebuffer;
            gl.bindRenderbuffer(RENDERBUFFER, newRb);
            gl.renderbufferStorage(RENDERBUFFER, format, rt.width, rt.height);
            gl.framebufferRenderbuffer(FRAMEBUFFER, attachment, RENDERBUFFER, newRb);
            gl.bindRenderbuffer(RENDERBUFFER, null);
            const status = gl.checkFramebufferStatus(FRAMEBUFFER);
            if (status !== FRAMEBUFFER_COMPLETE) {
                throw new Error(`lite-gl: render target framebuffer incomplete after stencil attach (status 0x${status.toString(16)})`);
            }
            // Commit only after a complete attachment: release the buffer we
            // replaced (the core depth-only one, or our own from a prior rebuild).
            if (rt._depthStencil !== null) {
                gl.deleteRenderbuffer(rt._depthStencil);
            }
            rt._depthStencil = newRb;
            committed = true;
        } finally {
            if (!committed) {
                // Any non-committed exit (incomplete framebuffer OR an unexpected
                // GL throw): detach + delete the buffer we couldn't adopt so it
                // never leaks, leaving the attachment point empty for the
                // caller-level rollback to re-establish the prior buffer.
                gl.framebufferRenderbuffer(FRAMEBUFFER, attachment, RENDERBUFFER, null);
                gl.deleteRenderbuffer(newRb);
            }
            // Restore the caller's draw target + the bound-framebuffer cache.
            if (e._state.boundFramebuffer !== prevFb) {
                gl.bindFramebuffer(FRAMEBUFFER, prevFb);
                e._state.boundFramebuffer = prevFb;
            }
        }
    };

    // Build once now, but COMMIT the resize/restore hook only if it succeeds — a
    // failed opt-in must leave the target exactly as it was. The packed attach
    // above can clear the core `DEPTH_ATTACHMENT`, so on failure restore the prior
    // hook AND re-establish the prior depth/stencil attachment (the prior hook's,
    // or the core depth-only buffer).
    const prevHook = rt._rebuildDepthStencil;
    const prevDepthStencil = rt._depthStencil;
    try {
        build(engine);
    } catch (err) {
        rt._rebuildDepthStencil = prevHook;
        try {
            if (prevHook !== undefined) {
                prevHook(engine);
            } else if (prevDepthStencil !== null) {
                reattachCoreDepthBuffer(engine, rt, prevDepthStencil);
            }
        } catch {
            // Best-effort restore; surface the original failure below.
        }
        throw err;
    }
    rt._rebuildDepthStencil = build;
}

/**
 * Re-attach a core depth-only renderbuffer at `DEPTH_ATTACHMENT` — used to roll a
 * render target back when a packed {@link generateRenderTargetStencil} attach
 * fails completeness (attaching at `DEPTH_STENCIL_ATTACHMENT` clears the core
 * `DEPTH_ATTACHMENT`). State-neutral: restores the caller's bound framebuffer.
 * @internal
 */
function reattachCoreDepthBuffer(engine: GLEngineContext, rt: GLRenderTarget, depthBuffer: WebGLRenderbuffer): void {
    const gl = engine.gl;
    const prevFb = engine._state.boundFramebuffer;
    gl.bindFramebuffer(FRAMEBUFFER, rt._framebuffer);
    engine._state.boundFramebuffer = rt._framebuffer;
    gl.framebufferRenderbuffer(FRAMEBUFFER, DEPTH_ATTACHMENT, RENDERBUFFER, depthBuffer);
    if (engine._state.boundFramebuffer !== prevFb) {
        gl.bindFramebuffer(FRAMEBUFFER, prevFb);
        engine._state.boundFramebuffer = prevFb;
    }
}
