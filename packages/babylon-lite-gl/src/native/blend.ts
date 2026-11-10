/**
 * Native blend module — the native-backend twin of `blend.ts`. Mirrors its
 * PUBLIC API (GLBlendMode / GLBlendEquation / setBlendMode / setBlendState /
 * disableBlend) with the same deferred model (record desired, flush before draw
 * via native-apply-states).
 *
 * NATIVE DIVERGENCE: Babylon Native exposes only PRESET blend modes
 * (`COMMAND_SETBLENDMODE` with an `ALPHA_*` enum), not the separate src/dst/
 * equation functions WebGL supports. {@link setBlendState} (arbitrary funcs) is
 * therefore approximated to the nearest preset — see its note.
 */
import type { GLEngineContext } from "./native-context.js";
import { dSetBlendMode, nativeAlphaMode } from "./native-device.js";

/** Blend presets — values mirror Babylon's `Constants.ALPHA_*` (and the WebGL
 *  module's {@link GLBlendMode}). */
export const GLBlendMode = {
    /** No blending. */
    DISABLE: 0,
    /** Additive. */
    ADD: 1,
    /** Standard (non-premultiplied) alpha. */
    ALPHA: 2,
    /** Premultiplied alpha. */
    PREMULTIPLIED: 7,
} as const;

/** One of the {@link GLBlendMode} preset values. */
export type GLBlendMode = (typeof GLBlendMode)[keyof typeof GLBlendMode];

/** Blend equation presets — kept for API parity with the WebGL module. Native
 *  presets always use FUNC_ADD; non-add equations are not expressible on native. */
export const GLBlendEquation = {
    /** src + dst. */
    ADD: 0x8006,
    /** src - dst. */
    SUBTRACT: 0x800a,
    /** dst - src. */
    REVERSE_SUBTRACT: 0x800b,
    /** min(src, dst). */
    MIN: 0x8007,
    /** max(src, dst). */
    MAX: 0x8008,
} as const;

/** One of the {@link GLBlendEquation} preset values. */
export type GLBlendEquation = (typeof GLBlendEquation)[keyof typeof GLBlendEquation];

/** Arbitrary separate-channel blend config — same shape as the WebGL module.
 *  On native it is approximated to a preset (see {@link setBlendState}). */
export interface GLBlendState {
    /** RGB source factor (WebGL enum). */
    srcRGB: number;
    /** RGB destination factor. */
    dstRGB: number;
    /** Alpha source factor. */
    srcAlpha: number;
    /** Alpha destination factor. */
    dstAlpha: number;
    /** RGB blend equation. */
    equationRGB?: number;
    /** Alpha blend equation. */
    equationAlpha?: number;
}

/** WebGL blend-factor enums used to detect the standard-alpha preset. */
const GL_ONE = 1;
const GL_ONE_MINUS_SRC_ALPHA = 0x0303;
const GL_SRC_ALPHA = 0x0302;

/**
 * Set a blend preset (deferred; flushed before the next native draw). Mirrors the
 * WebGL `setBlendMode`.
 */
export function setBlendMode(engine: GLEngineContext, mode: GLBlendMode): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    recordBlend(engine, mode);
}

/**
 * Approximate an arbitrary separate-channel blend as the nearest native preset.
 * `(ONE, ONE_MINUS_SRC_ALPHA)` → PREMULTIPLIED, `(SRC_ALPHA, ONE)` → ADD, any
 * other enabled config → ALPHA (combine). Native cannot express arbitrary
 * src/dst/equation funcs, so this is a documented lossy mapping (the WebGL
 * backend is exact).
 */
export function setBlendState(engine: GLEngineContext, state: GLBlendState): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    let mode: GLBlendMode = GLBlendMode.ALPHA;
    if (state.srcRGB === GL_ONE && state.dstRGB === GL_ONE_MINUS_SRC_ALPHA) {
        mode = GLBlendMode.PREMULTIPLIED;
    } else if (state.srcRGB === GL_SRC_ALPHA && state.dstRGB === GL_ONE) {
        mode = GLBlendMode.ADD;
    }
    recordBlend(engine, mode);
}

/** Disable blending (deferred). Mirrors the WebGL `disableBlend`. */
export function disableBlend(engine: GLEngineContext): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    recordBlend(engine, GLBlendMode.DISABLE);
}

/** Record the desired preset + install the reconciler. */
function recordBlend(engine: GLEngineContext, mode: number): void {
    const s = engine._state;
    s.blendModeDesired = mode;
    s._flushBlend = flushBlend;
    s.statesDirty = true;
}

/**
 * Reconcile the desired blend preset → actual, emitting `COMMAND_SETBLENDMODE`
 * only when it changed. Installed on `_state._flushBlend`; dispatched by
 * `applyNativeStates`. @internal
 */
function flushBlend(engine: GLEngineContext): void {
    const s = engine._state;
    if (s.blendModeDesired === -1 || s.blendModeDesired === s.blendModeActual) {
        return;
    }
    s.blendModeActual = s.blendModeDesired;
    dSetBlendMode(engine, nativeAlphaMode(s.blendModeDesired));
}
