/**
 * Native depth / stencil / color-mask / clear module — the native-backend twin of
 * `depth-stencil.ts`, with the same API. Same DEFERRED model (record desired into
 * the `rs` slots, install per-category reconcilers, flush before draw/clear via
 * native-apply-states); the reconcilers emit native commands
 * (`COMMAND_SETDEPTHTEST` / `SETDEPTHWRITE` / `SETSTATE` / `SETSTENCIL` /
 * `SETCOLORWRITE`) instead of `gl.*`.
 *
 * NATIVE DIVERGENCES:
 *  - `COMMAND_SETDEPTHTEST` conflates enable + compare func: a disabled depth
 *    test is encoded as `DEPTH_TEST_ALWAYS` (as in `ThinNativeEngine`).
 *  - `COMMAND_SETCOLORWRITE` is all-channels; a partial WebGL color mask maps to
 *    "write enabled" when ANY channel is enabled.
 *  - Native has ONE stencil op set (no two-sided stencil, `caps.separateStencil`
 *    false); see {@link setStencilOpSeparate}. The comparison mask (`funcMask`)
 *    is honoured on hosts exposing `COMMAND_SETSTENCIL2`; older hosts compare
 *    with a fixed 0xFF.
 */
import type { GLEngineContext } from "./native-context.js";
import type { GLRenderTarget } from "./render-target.js";
import { rebuildRenderTargetFramebuffer } from "./render-target.js";
import type { GLClearOptions, GLDepthState, GLStencilOpState, GLStencilState } from "../depth-stencil.js";
import { applyNativeStates } from "./native-apply-states.js";
import { dClear, dSetColorWrite, dSetCull, dSetDepthTest, dSetDepthWrite, dSetStencil } from "./native-device.js";
import {
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
} from "./native-state.js";

export type { GLDepthState, GLStencilState, GLStencilOpState, GLClearOptions } from "../depth-stencil.js";

/** WebGL cull-face enum for back faces (`gl.BACK`). */
const GL_BACK = 0x0405;
/** `gl.FRONT`. */
const GL_FRONT = 0x0404;
/** `gl.FRONT_AND_BACK`. */
const GL_FRONT_AND_BACK = 0x0408;
/** `gl.KEEP`. */
const GL_KEEP = 0x1e00;

/**
 * Record desired depth state (deferred) — mirrors the WebGL `setDepthState`.
 * `func` maps to the native `DEPTH_TEST_*` compare function (default `LESS`).
 * @param engine - The engine.
 * @param state - Fields to change; omitted fields keep their desired value.
 */
export function setDepthState(engine: GLEngineContext, state: GLDepthState): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const rs = engine._state.rs;
    if (state.test !== undefined) {
        rs[RS_DEPTH_TEST + RS_DESIRED] = state.test ? 1 : 0;
    }
    if (state.write !== undefined) {
        rs[RS_DEPTH_MASK + RS_DESIRED] = state.write ? 1 : 0;
    }
    if (state.func !== undefined) {
        rs[RS_DEPTH_FUNC + RS_DESIRED] = state.func;
    }
    engine._state._flushDepthCull = flushDepthCull;
    engine._state.statesDirty = true;
}

/**
 * Record desired cull state (deferred) — mirrors the WebGL `setCullState`.
 * @param engine - The engine.
 * @param enabled - Enable face culling.
 * @param face - `gl.BACK` (default) or `gl.FRONT`.
 */
export function setCullState(engine: GLEngineContext, enabled: boolean, face?: GLenum): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const rs = engine._state.rs;
    rs[RS_CULL_ENABLED + RS_DESIRED] = enabled ? 1 : 0;
    rs[RS_CULL_FACE + RS_DESIRED] = face ?? GL_BACK;
    engine._state._flushDepthCull = flushDepthCull;
    engine._state.statesDirty = true;
}

/**
 * Record desired stencil state (deferred) — mirrors the WebGL `setStencilState`.
 * Ops apply to both faces (re-unifying any {@link setStencilOpSeparate} split).
 * NATIVE: `funcMask` (low 8 bits) needs a host exposing `COMMAND_SETSTENCIL2`;
 * older hosts compare with a fixed 0xFF.
 * @param engine - The engine.
 * @param state - Fields to change; omitted fields keep their desired value.
 */
export function setStencilState(engine: GLEngineContext, state: GLStencilState): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const s = engine._state;
    const rs = s.rs;
    if (state.test !== undefined) {
        rs[RS_STENCIL_TEST + RS_DESIRED] = state.test ? 1 : 0;
    }
    if (state.mask !== undefined) {
        rs[RS_STENCIL_MASK + RS_DESIRED] = state.mask;
    }
    if (state.func !== undefined) {
        rs[RS_STENCIL_FUNC_FUNC + RS_DESIRED] = state.func;
    }
    if (state.ref !== undefined) {
        rs[RS_STENCIL_FUNC_REF + RS_DESIRED] = state.ref;
    }
    if (state.funcMask !== undefined) {
        rs[RS_STENCIL_FUNC_MASK + RS_DESIRED] = state.funcMask;
    }
    setFrontOps(rs, state);
    if (s._stencilBackOps !== undefined) {
        setBackOps(s._stencilBackOps, state);
    }
    s._flushStencil = flushStencil;
    s.statesDirty = true;
}

/**
 * Buffer stencil operations for one face (≙ WebGL `setStencilOpSeparate`).
 *
 * NATIVE DIVERGENCE: Babylon Native has a single stencil op set
 * (`caps.separateStencil` is false). `FRONT_AND_BACK` — or per-face calls that
 * leave both faces with identical ops (e.g. `FRONT` then `BACK` with the same
 * ops) — map to the single-sided path. If the faces still differ when the state
 * is flushed (next draw / clear) with the stencil test enabled, that flush throws
 * `lite-gl: setStencilOpSeparate with different front/back ops is not supported on Babylon Native`.
 *
 * @param engine - The engine.
 * @param face - `gl.FRONT`, `gl.BACK`, or `gl.FRONT_AND_BACK`.
 * @param state - The operation fields to change for the selected face(s).
 * @throws If `face` is not `gl.FRONT`, `gl.BACK`, or `gl.FRONT_AND_BACK`.
 */
export function setStencilOpSeparate(engine: GLEngineContext, face: GLenum, state: GLStencilOpState): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    if (face !== GL_FRONT && face !== GL_BACK && face !== GL_FRONT_AND_BACK) {
        throw new Error("lite-gl: invalid face");
    }
    if ((state.opFail ?? state.opZFail ?? state.opZPass) === undefined) {
        return;
    }
    const s = engine._state;
    const rs = s.rs;
    if (face !== GL_FRONT_AND_BACK && s._stencilBackOps === undefined) {
        s._stencilBackOps = [rs[RS_STENCIL_OP_FAIL + RS_DESIRED]!, rs[RS_STENCIL_OP_ZFAIL + RS_DESIRED]!, rs[RS_STENCIL_OP_ZPASS + RS_DESIRED]!];
    }
    if (face !== GL_BACK) {
        setFrontOps(rs, state);
    }
    if (face !== GL_FRONT && s._stencilBackOps !== undefined) {
        setBackOps(s._stencilBackOps, state);
    }
    s._flushStencil = flushStencil;
    s.statesDirty = true;
}

/** Record the desired color write mask (deferred). Native writes all channels or
 *  none, so a partial mask enables writing when ANY channel is set. Mirrors the
 *  WebGL `setColorMask`.
 *  @param engine - The engine.
 *  @param r - Write red.
 *  @param g - Write green.
 *  @param b - Write blue.
 *  @param a - Write alpha. */
export function setColorMask(engine: GLEngineContext, r: boolean, g: boolean, b: boolean, a: boolean): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    engine._state.rs[RS_COLOR_MASK + RS_DESIRED] = (r ? 1 : 0) | (g ? 2 : 0) | (b ? 4 : 0) | (a ? 8 : 0);
    engine._state._flushColorMask = flushColorMask;
    engine._state.statesDirty = true;
}

/** Flush deferred state, then clear the bound target (matching the WebGL
 *  `clearEngine`, whose clear respects the current write masks).
 *  @param engine - The engine.
 *  @param options - What to clear. */
export function clearEngine(engine: GLEngineContext, options: GLClearOptions): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    applyNativeStates(engine);
    const c = options.color;
    dClear(engine, c ? c.r : 0, c ? c.g : 0, c ? c.b : 0, c ? (c.a ?? 1) : 1, c !== undefined, options.depth ?? false, options.stencil ?? false, 0);
}

/**
 * Give a render target a stencil attachment (≙ WebGL `generateRenderTargetStencil`).
 * Native bakes depth/stencil into the framebuffer, so this rebuilds the target's
 * framebuffer (keeping the color texture and its contents) with a packed D24S8
 * depth+stencil attachment; the setting survives resize and device restore.
 *
 * NATIVE: stencil-only (`depth: false`) is not available — the host always packs
 * depth with stencil, so the attachment is D24S8 either way.
 *
 * No-op on a lost/disposed engine or a disposed target.
 *
 * @param rt - The render target to attach the stencil buffer to.
 * @param options - `depth` (default `true`); see the note above.
 */
export function generateRenderTargetStencil(rt: GLRenderTarget, options?: { depth?: boolean }): void {
    const engine = rt._engine;
    if (engine._isLost || engine._disposed || rt._disposed) {
        return;
    }
    void options;
    if (rt._config.hasStencil) {
        return;
    }
    rt._config.hasStencil = true;
    rebuildRenderTargetFramebuffer(rt);
}

/** Apply the provided op fields to the shared (front) desired slots. */
function setFrontOps(rs: Float64Array, state: GLStencilOpState): void {
    if (state.opFail !== undefined) {
        rs[RS_STENCIL_OP_FAIL + RS_DESIRED] = state.opFail;
    }
    if (state.opZFail !== undefined) {
        rs[RS_STENCIL_OP_ZFAIL + RS_DESIRED] = state.opZFail;
    }
    if (state.opZPass !== undefined) {
        rs[RS_STENCIL_OP_ZPASS + RS_DESIRED] = state.opZPass;
    }
}

/** Apply the provided op fields to the back-face desired ops. */
function setBackOps(back: number[], state: GLStencilOpState): void {
    if (state.opFail !== undefined) {
        back[0] = state.opFail;
    }
    if (state.opZFail !== undefined) {
        back[1] = state.opZFail;
    }
    if (state.opZPass !== undefined) {
        back[2] = state.opZPass;
    }
}

/** Normalize an op slot (`-1` = unset = GL default KEEP). */
function op(v: number): number {
    return v === -1 ? GL_KEEP : v;
}

/* ────────────────────────────  reconcilers  ──────────────────────────────── */

/** Depth + cull reconciler. @internal */
function flushDepthCull(engine: GLEngineContext): void {
    const rs = engine._state.rs;
    const dTest = rs[RS_DEPTH_TEST + RS_DESIRED]!;
    const dFunc = rs[RS_DEPTH_FUNC + RS_DESIRED]!;
    if (dTest !== -1 && (dTest !== rs[RS_DEPTH_TEST] || (dTest === 1 && dFunc !== rs[RS_DEPTH_FUNC]))) {
        rs[RS_DEPTH_TEST] = dTest;
        rs[RS_DEPTH_FUNC] = dFunc;
        dSetDepthTest(engine, dTest === 1 ? nativeDepthFunc(dFunc) : _native.Engine.DEPTH_TEST_ALWAYS);
    }
    const dMask = rs[RS_DEPTH_MASK + RS_DESIRED]!;
    if (dMask !== -1 && dMask !== rs[RS_DEPTH_MASK]) {
        rs[RS_DEPTH_MASK] = dMask;
        dSetDepthWrite(engine, dMask === 1);
    }
    const dCull = rs[RS_CULL_ENABLED + RS_DESIRED]!;
    const dFace = rs[RS_CULL_FACE + RS_DESIRED]!;
    if (dCull !== -1 && (dCull !== rs[RS_CULL_ENABLED] || dFace !== rs[RS_CULL_FACE])) {
        rs[RS_CULL_ENABLED] = dCull;
        rs[RS_CULL_FACE] = dFace;
        dSetCull(engine, dCull === 1, dFace === GL_BACK);
    }
}

/** Stencil reconciler — reconciles the whole stencil config as one unit
 *  (native `COMMAND_SETSTENCIL` sets all fields together). @internal */
function flushStencil(engine: GLEngineContext): void {
    const s = engine._state;
    const rs = s.rs;
    const dTest = rs[RS_STENCIL_TEST + RS_DESIRED]!;
    const back = s._stencilBackOps;
    // Ops are irrelevant while the stencil test is off, so a split only fails
    // once it would actually affect rendering.
    if (dTest === 1 && back !== undefined) {
        if (
            op(back[0]!) !== op(rs[RS_STENCIL_OP_FAIL + RS_DESIRED]!) ||
            op(back[1]!) !== op(rs[RS_STENCIL_OP_ZFAIL + RS_DESIRED]!) ||
            op(back[2]!) !== op(rs[RS_STENCIL_OP_ZPASS + RS_DESIRED]!)
        ) {
            throw new Error("lite-gl: setStencilOpSeparate with different front/back ops is not supported on Babylon Native (caps.separateStencil is false)");
        }
    }
    if (dTest === -1) {
        return;
    }
    // Any change to enable / mask / func / ref / ops re-emits the command.
    const mask = rs[RS_STENCIL_MASK + RS_DESIRED]!;
    const func = rs[RS_STENCIL_FUNC_FUNC + RS_DESIRED]!;
    const ref = rs[RS_STENCIL_FUNC_REF + RS_DESIRED]!;
    const funcMask = rs[RS_STENCIL_FUNC_MASK + RS_DESIRED]!;
    const opFail = rs[RS_STENCIL_OP_FAIL + RS_DESIRED]!;
    const opZFail = rs[RS_STENCIL_OP_ZFAIL + RS_DESIRED]!;
    const opZPass = rs[RS_STENCIL_OP_ZPASS + RS_DESIRED]!;
    const changed =
        dTest !== rs[RS_STENCIL_TEST] ||
        mask !== rs[RS_STENCIL_MASK] ||
        func !== rs[RS_STENCIL_FUNC_FUNC] ||
        ref !== rs[RS_STENCIL_FUNC_REF] ||
        funcMask !== rs[RS_STENCIL_FUNC_MASK] ||
        opFail !== rs[RS_STENCIL_OP_FAIL] ||
        opZFail !== rs[RS_STENCIL_OP_ZFAIL] ||
        opZPass !== rs[RS_STENCIL_OP_ZPASS];
    if (!changed) {
        return;
    }
    rs[RS_STENCIL_TEST] = dTest;
    rs[RS_STENCIL_MASK] = mask;
    rs[RS_STENCIL_FUNC_FUNC] = func;
    rs[RS_STENCIL_FUNC_REF] = ref;
    rs[RS_STENCIL_FUNC_MASK] = funcMask;
    rs[RS_STENCIL_OP_FAIL] = opFail;
    rs[RS_STENCIL_OP_ZFAIL] = opZFail;
    rs[RS_STENCIL_OP_ZPASS] = opZPass;
    if (dTest === 1) {
        dSetStencil(engine, mask & 0xff, nativeStencilOpFail(opFail), nativeStencilOpZFail(opZFail), nativeStencilOpZPass(opZPass), nativeStencilFunc(func), ref, funcMask);
    } else {
        // Disabled: KEEP ops + ALWAYS func (matches ThinNativeEngine.setStencilBuffer(false)).
        dSetStencil(
            engine,
            255,
            _native.Engine.STENCIL_OP_FAIL_S_KEEP,
            _native.Engine.STENCIL_OP_FAIL_Z_KEEP,
            _native.Engine.STENCIL_OP_PASS_Z_KEEP,
            _native.Engine.STENCIL_TEST_ALWAYS,
            0,
            0xff
        );
    }
}

/** Color-mask reconciler. @internal */
function flushColorMask(engine: GLEngineContext): void {
    const rs = engine._state.rs;
    const dMask = rs[RS_COLOR_MASK + RS_DESIRED]!;
    if (dMask !== -1 && dMask !== rs[RS_COLOR_MASK]) {
        rs[RS_COLOR_MASK] = dMask;
        dSetColorWrite(engine, dMask !== 0);
    }
}

/* ──────────────  WebGL→native stencil enum mapping helpers  ────────────────── */

/** Map a WebGL depth comparison enum to the native `DEPTH_TEST_*` (`-1` → LESS). */
function nativeDepthFunc(func: number): number {
    switch (func) {
        case 0x0200:
            return _native.Engine.DEPTH_TEST_NEVER;
        case 0x0202:
            return _native.Engine.DEPTH_TEST_EQUAL;
        case 0x0203:
            return _native.Engine.DEPTH_TEST_LEQUAL;
        case 0x0204:
            return _native.Engine.DEPTH_TEST_GREATER;
        case 0x0205:
            return _native.Engine.DEPTH_TEST_NOTEQUAL;
        case 0x0206:
            return _native.Engine.DEPTH_TEST_GEQUAL;
        case 0x0207:
            return _native.Engine.DEPTH_TEST_ALWAYS;
        default:
            return _native.Engine.DEPTH_TEST_LESS;
    }
}

/** Map a WebGL stencil comparison enum to the native `STENCIL_TEST_*`. */
function nativeStencilFunc(func: number): number {
    switch (func) {
        case 0x0200:
            return _native.Engine.STENCIL_TEST_NEVER;
        case 0x0201:
            return _native.Engine.STENCIL_TEST_LESS;
        case 0x0202:
            return _native.Engine.STENCIL_TEST_EQUAL;
        case 0x0203:
            return _native.Engine.STENCIL_TEST_LEQUAL;
        case 0x0204:
            return _native.Engine.STENCIL_TEST_GREATER;
        case 0x0205:
            return _native.Engine.STENCIL_TEST_NOTEQUAL;
        case 0x0206:
            return _native.Engine.STENCIL_TEST_GEQUAL;
        default:
            return _native.Engine.STENCIL_TEST_ALWAYS;
    }
}

/** Map a WebGL stencil op enum to the native `STENCIL_OP_FAIL_S_*`. */
function nativeStencilOpFail(op: number): number {
    switch (op) {
        case 0x0000:
            return _native.Engine.STENCIL_OP_FAIL_S_ZERO;
        case 0x1e01:
            return _native.Engine.STENCIL_OP_FAIL_S_REPLACE;
        case 0x1e02:
        case 0x8507:
            return _native.Engine.STENCIL_OP_FAIL_S_INCR;
        case 0x1e03:
        case 0x8508:
            return _native.Engine.STENCIL_OP_FAIL_S_DECR;
        case 0x150a:
            return _native.Engine.STENCIL_OP_FAIL_S_INVERT;
        default:
            return _native.Engine.STENCIL_OP_FAIL_S_KEEP;
    }
}

/** Map a WebGL stencil op enum to the native `STENCIL_OP_FAIL_Z_*`. */
function nativeStencilOpZFail(op: number): number {
    switch (op) {
        case 0x0000:
            return _native.Engine.STENCIL_OP_FAIL_Z_ZERO;
        case 0x1e01:
            return _native.Engine.STENCIL_OP_FAIL_Z_REPLACE;
        case 0x1e02:
        case 0x8507:
            return _native.Engine.STENCIL_OP_FAIL_Z_INCR;
        case 0x1e03:
        case 0x8508:
            return _native.Engine.STENCIL_OP_FAIL_Z_DECR;
        case 0x150a:
            return _native.Engine.STENCIL_OP_FAIL_Z_INVERT;
        default:
            return _native.Engine.STENCIL_OP_FAIL_Z_KEEP;
    }
}

/** Map a WebGL stencil op enum to the native `STENCIL_OP_PASS_Z_*`. */
function nativeStencilOpZPass(op: number): number {
    switch (op) {
        case 0x0000:
            return _native.Engine.STENCIL_OP_PASS_Z_ZERO;
        case 0x1e01:
            return _native.Engine.STENCIL_OP_PASS_Z_REPLACE;
        case 0x1e02:
        case 0x8507:
            return _native.Engine.STENCIL_OP_PASS_Z_INCR;
        case 0x1e03:
        case 0x8508:
            return _native.Engine.STENCIL_OP_PASS_Z_DECR;
        case 0x150a:
            return _native.Engine.STENCIL_OP_PASS_Z_INVERT;
        default:
            return _native.Engine.STENCIL_OP_PASS_Z_KEEP;
    }
}
