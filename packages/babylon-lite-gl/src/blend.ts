/**
 * Blend-mode state — the WebGL counterpart of Babylon's `Engine.setAlphaMode`.
 *
 * The numeric {@link GLBlendMode} values intentionally match Babylon's
 * `Constants.ALPHA_*` (`ALPHA_DISABLE = 0`, `ALPHA_ADD = 1`, `ALPHA_COMBINE = 2`,
 * `ALPHA_PREMULTIPLIED = 7`) so NeonBrush can forward raw Babylon constants
 * without a translation table. `setBlendMode` replicates the exact
 * `gl.blendFuncSeparate` parameters issued by Babylon's
 * `ThinEngine.setAlphaMode` for each mode (see `Engines/Extensions/engine.alpha.js`).
 */
import { type GLEngineContext } from "./context.js";

/**
 * Supported blend modes. Values mirror Babylon's `Constants.ALPHA_*` so the
 * raw Babylon integers can be passed straight through.
 */
export const GLBlendMode = {
    /** No blending — `gl.disable(gl.BLEND)`. (`Constants.ALPHA_DISABLE`) */
    DISABLE: 0,
    /** Additive — `blendFuncSeparate(SRC_ALPHA, ONE, ZERO, ONE)`. (`Constants.ALPHA_ADD`) */
    ADD: 1,
    /** Standard (non-premultiplied) alpha — `blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE)`. (`Constants.ALPHA_COMBINE`) */
    ALPHA: 2,
    /** Premultiplied alpha — `blendFuncSeparate(ONE, ONE_MINUS_SRC_ALPHA, ONE, ONE)`. (`Constants.ALPHA_PREMULTIPLIED`) */
    PREMULTIPLIED: 7,
} as const;

/** One of the {@link GLBlendMode} preset values (`0`, `1`, `2` or `7`). */
export type GLBlendMode = (typeof GLBlendMode)[keyof typeof GLBlendMode];

/** Sentinel meaning "no blend mode applied yet" — distinct from every real
 *  {@link GLBlendMode} value so the first `setBlendMode` is never elided and
 *  the cache starts in a known state (matches `GLState.blendMode` init). */
const BLEND_UNSET = -1;

/**
 * Set the GL blend state to match Babylon's `setAlphaMode(mode)` exactly.
 *
 * The blend func parameters are copied verbatim from Babylon's
 * `ThinEngine.setAlphaMode` (`Engines/Extensions/engine.alpha.js`):
 *
 * | Mode               | `gl.blendFuncSeparate(srcRGB, dstRGB, srcA, dstA)`          |
 * |--------------------|------------------------------------------------------------|
 * | `DISABLE` (0)      | — (`gl.disable(gl.BLEND)`)                                  |
 * | `ADD` (1)          | `SRC_ALPHA, ONE, ZERO, ONE`                                 |
 * | `ALPHA` (2)        | `SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE`                  |
 * | `PREMULTIPLIED` (7)| `ONE, ONE_MINUS_SRC_ALPHA, ONE, ONE`                        |
 *
 * The result is cached in `engine._state.blendMode`; a redundant call with the
 * unchanged mode is a no-op. The blend equation is set explicitly to
 * `FUNC_ADD` (the GL default Babylon's `AlphaState` relies on — its
 * `setAlphaMode` leaves the equation implicit) the first time blending is
 * enabled from a disabled/unset state, keeping the result deterministic.
 *
 * No-op when the context is lost or disposed. Default behaviour is unchanged
 * for code that never calls this — `drawEffect` does not touch blend state, so
 * existing fullscreen-effect parity is preserved.
 *
 * @param engine - The engine whose GL blend state is updated.
 * @param mode - The {@link GLBlendMode} to apply.
 */
export function setBlendMode(engine: GLEngineContext, mode: GLBlendMode): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const s = engine._state;
    const prev = s.blendMode;
    if (prev === mode) {
        return;
    }
    const gl = engine.gl;
    if (mode === GLBlendMode.DISABLE) {
        s.blendMode = mode;
        gl.disable(gl.BLEND);
        return;
    }
    // Enable blending (and pin the equation) only on the disabled/unset -> enabled
    // transition, mirroring Babylon's AlphaState dirty-flag elision.
    const wasEnabled = prev !== GLBlendMode.DISABLE && prev !== BLEND_UNSET;
    s.blendMode = mode;
    if (!wasEnabled) {
        gl.enable(gl.BLEND);
        gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
    }
    switch (mode) {
        case GLBlendMode.ADD:
            gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
            break;
        case GLBlendMode.ALPHA:
            gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);
            break;
        case GLBlendMode.PREMULTIPLIED:
            gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);
            break;
    }
}
