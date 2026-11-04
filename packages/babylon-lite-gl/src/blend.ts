/**
 * Blend-mode state — the WebGL counterpart of Babylon's `Engine.setAlphaMode`
 * (presets) and `AlphaState.setAlphaBlendFunctionParameters` /
 * `setAlphaEquationParameters` (the arbitrary separate func + equation path).
 *
 * The numeric {@link GLBlendMode} values intentionally match Babylon's
 * `Constants.ALPHA_*` (`ALPHA_DISABLE = 0`, `ALPHA_ADD = 1`, `ALPHA_COMBINE = 2`,
 * `ALPHA_PREMULTIPLIED = 7`) so a consumer can forward raw Babylon constants
 * without a translation table.
 *
 * DEFERRED MODEL (matches Babylon's `AlphaState`): these setters do NOT touch
 * `gl.*`. They record only the DESIRED blend config into the `d*` mirror fields
 * of `GLState` and raise `statesDirty`; `applyGLStates` (apply-states.ts) flushes
 * the diff to GL right before each draw / clear. Setting blend A then B then A
 * with no draw in between therefore applies exactly one blend state (A), and a
 * blend left unchanged across frames re-issues nothing.
 *
 * Both {@link setBlendMode} and {@link setBlendState} feed the same desired
 * fields, so the preset and arbitrary paths can never desync.
 */
import { type GLEngineContext } from "./context.js";
import { RS_BLEND_DST_A, RS_BLEND_DST_RGB, RS_BLEND_ENABLED, RS_BLEND_EQ_A, RS_BLEND_EQ_RGB, RS_BLEND_SRC_A, RS_BLEND_SRC_RGB, RS_DESIRED } from "./state.js";

/**
 * Supported blend presets. Values mirror Babylon's `Constants.ALPHA_*` so the
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

/**
 * Blend equation presets — the values WebGL2 accepts for
 * `gl.blendEquationSeparate`. Numeric values equal the GL enums so raw GL
 * integers (or Babylon's identical `Constants.GL_ALPHA_EQUATION_*`) pass
 * straight through.
 */
export const GLBlendEquation = {
    /** `src + dst` (the GL default). */
    ADD: 0x8006,
    /** `src - dst`. */
    SUBTRACT: 0x800a,
    /** `dst - src`. */
    REVERSE_SUBTRACT: 0x800b,
    /** `min(src, dst)`. */
    MIN: 0x8007,
    /** `max(src, dst)`. */
    MAX: 0x8008,
} as const;

/** One of the {@link GLBlendEquation} preset values. */
export type GLBlendEquation = (typeof GLBlendEquation)[keyof typeof GLBlendEquation];

/**
 * Arbitrary separate-channel blend configuration — the lite-gl equivalent of
 * Babylon's `AlphaState.setAlphaBlendFunctionParameters` +
 * `setAlphaEquationParameters`. All factor / equation fields are raw WebGL2
 * enums (`gl.ONE`, `gl.SRC_ALPHA`, `gl.MIN`, …); use {@link GLBlendEquation} for
 * the equations if you prefer named presets.
 */
export interface GLBlendState {
    /** RGB source factor (`gl.blendFuncSeparate` arg 1). */
    srcRGB: GLenum;
    /** RGB destination factor (`gl.blendFuncSeparate` arg 2). */
    dstRGB: GLenum;
    /** Alpha source factor (`gl.blendFuncSeparate` arg 3). */
    srcAlpha: GLenum;
    /** Alpha destination factor (`gl.blendFuncSeparate` arg 4). */
    dstAlpha: GLenum;
    /** RGB blend equation. Defaults to `FUNC_ADD`. */
    equationRGB?: GLenum;
    /** Alpha blend equation. Defaults to `FUNC_ADD`. */
    equationAlpha?: GLenum;
}

/** GL `FUNC_ADD` — the implicit equation used by the {@link GLBlendMode}
 *  presets (matching Babylon's `setAlphaMode`, which leaves it at the default). */
const FUNC_ADD = 0x8006;
/** GL `gl.BLEND`. */
const BLEND = 0x0be2;

/**
 * Set the GL blend state to match Babylon's `setAlphaMode(mode)` exactly.
 *
 * | Mode               | `gl.blendFuncSeparate(srcRGB, dstRGB, srcA, dstA)`          |
 * |--------------------|------------------------------------------------------------|
 * | `DISABLE` (0)      | — (`gl.disable(gl.BLEND)`)                                  |
 * | `ADD` (1)          | `SRC_ALPHA, ONE, ZERO, ONE`                                 |
 * | `ALPHA` (2)        | `SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE`                  |
 * | `PREMULTIPLIED` (7)| `ONE, ONE_MINUS_SRC_ALPHA, ONE, ONE`                        |
 *
 * No-op when the context is lost or disposed.
 *
 * @param engine - The engine whose GL blend state is updated.
 * @param mode - The {@link GLBlendMode} preset to apply.
 */
export function setBlendMode(engine: GLEngineContext, mode: GLBlendMode): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const gl = engine.gl;
    switch (mode) {
        case GLBlendMode.DISABLE:
            disableBlend(engine);
            return;
        case GLBlendMode.ADD:
            applyBlend(engine, gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE, FUNC_ADD, FUNC_ADD);
            return;
        case GLBlendMode.ALPHA:
            applyBlend(engine, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE, FUNC_ADD, FUNC_ADD);
            return;
        case GLBlendMode.PREMULTIPLIED:
            applyBlend(engine, gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE, FUNC_ADD, FUNC_ADD);
            return;
    }
}

/**
 * Enable blending with an arbitrary separate-channel function and equation —
 * the lite-gl equivalent of Babylon's `AlphaState` with
 * `setAlphaBlendFunctionParameters` + `setAlphaEquationParameters`.
 *
 * Supports every WebGL2 blend equation, including `MIN`, `MAX`,
 * `FUNC_SUBTRACT` and `FUNC_REVERSE_SUBTRACT` (used by ShapeBuilder's darken /
 * cutout blend modes). Records the desired config (flushed by `applyGLStates`
 * before the next draw); at flush time the enable flag, the equation and the func
 * are each cached independently, so a redundant state is fully elided and only
 * the call whose params changed is re-issued — mirroring Babylon's `AlphaState`
 * dirty flags. Because GL keeps the equation + func across `gl.disable(BLEND)`,
 * re-enabling with unchanged params re-issues neither.
 *
 * No-op when the context is lost or disposed.
 *
 * @param engine - The engine whose desired blend state is updated.
 * @param state - The separate-channel blend factors + equations to apply.
 */
export function setBlendState(engine: GLEngineContext, state: GLBlendState): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    applyBlend(engine, state.srcRGB, state.dstRGB, state.srcAlpha, state.dstAlpha, state.equationRGB ?? FUNC_ADD, state.equationAlpha ?? FUNC_ADD);
}

/**
 * Disable blending — the equivalent of Babylon's `AlphaState.alphaBlend = false`.
 * Records the desired "blend off" state (flushed by `applyGLStates` before the
 * next draw); the actual `gl.disable(gl.BLEND)` is elided when blending is
 * already off at flush time. No-op when the context is lost or disposed.
 *
 * @param engine - The engine whose desired blend state is updated.
 */
export function disableBlend(engine: GLEngineContext): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const s = engine._state;
    s.rs[RS_BLEND_ENABLED + RS_DESIRED] = 0;
    s._flushBlend = flushBlend;
    s.statesDirty = true;
}

/* ────────────────────────────  internal apply  ──────────────────────────── */

/** Record a granular blend config into the DESIRED (`rs[RS_* + RS_DESIRED]`)
 *  slots and mark it dirty. No `gl.*` here — `applyGLStates` reconciles
 *  desired→actual at the next flush, caching the enable flag, equation and func
 *  independently so each is re-issued only when its params change (and never on a
 *  bare re-enable). */
function applyBlend(engine: GLEngineContext, srcRGB: number, dstRGB: number, srcAlpha: number, dstAlpha: number, eqRGB: number, eqAlpha: number): void {
    const rs = engine._state.rs;
    rs[RS_BLEND_ENABLED + RS_DESIRED] = 1;
    rs[RS_BLEND_SRC_RGB + RS_DESIRED] = srcRGB;
    rs[RS_BLEND_DST_RGB + RS_DESIRED] = dstRGB;
    rs[RS_BLEND_SRC_A + RS_DESIRED] = srcAlpha;
    rs[RS_BLEND_DST_A + RS_DESIRED] = dstAlpha;
    rs[RS_BLEND_EQ_RGB + RS_DESIRED] = eqRGB;
    rs[RS_BLEND_EQ_A + RS_DESIRED] = eqAlpha;
    engine._state._flushBlend = flushBlend;
    engine._state.statesDirty = true;
}

/**
 * Reconcile the deferred blend state DESIRED → ACTUAL — the per-category half of
 * Babylon's `_alphaState.apply`. Installed onto `_state._flushBlend` by the blend
 * setters and dispatched by {@link applyGLStates}; co-located here so a scene that
 * never sets a blend mode tree-shakes both this reconciler and its GL code out of
 * the bundle.
 *
 * The enable flag, the equation and the func are reconciled as THREE independent
 * cached sub-states (mirroring Babylon's `_AlphaState` `_isAlphaBlendDirty` /
 * `_isBlendEquationParametersDirty` / `_isBlendFunctionParametersDirty`). GL
 * retains the blend equation + func across `gl.disable(BLEND)`, so their cached
 * actual values stay valid while blending is off — re-enabling with unchanged
 * params therefore issues ONLY `gl.enable(BLEND)` and re-issues neither
 * `blendEquationSeparate` nor `blendFuncSeparate`. A desired `-1` (never
 * requested) leaves GL untouched. @internal
 */
function flushBlend(engine: GLEngineContext): void {
    const gl = engine.gl;
    const rs = engine._state.rs;
    const dBlend = rs[RS_BLEND_ENABLED + RS_DESIRED]!;
    if (dBlend === -1) {
        return;
    }
    // 1. enable / disable — independent of the func + equation cache below.
    if (dBlend !== rs[RS_BLEND_ENABLED]) {
        rs[RS_BLEND_ENABLED] = dBlend;
        if (dBlend === 1) {
            gl.enable(BLEND);
        } else {
            gl.disable(BLEND);
        }
    }
    // While blending is off the equation/func are not observable and GL keeps the
    // last values, so leave their cache untouched (Babylon does the same) — the
    // next enable with identical params then re-issues nothing.
    if (dBlend !== 1) {
        return;
    }
    // 2. equation — re-issued only when the params actually changed.
    const eqRGB = rs[RS_BLEND_EQ_RGB + RS_DESIRED]!;
    const eqA = rs[RS_BLEND_EQ_A + RS_DESIRED]!;
    if (rs[RS_BLEND_EQ_RGB] !== eqRGB || rs[RS_BLEND_EQ_A] !== eqA) {
        gl.blendEquationSeparate(eqRGB, eqA);
        rs[RS_BLEND_EQ_RGB] = eqRGB;
        rs[RS_BLEND_EQ_A] = eqA;
    }
    // 3. func — re-issued only when the params actually changed.
    const srcRGB = rs[RS_BLEND_SRC_RGB + RS_DESIRED]!;
    const dstRGB = rs[RS_BLEND_DST_RGB + RS_DESIRED]!;
    const srcA = rs[RS_BLEND_SRC_A + RS_DESIRED]!;
    const dstA = rs[RS_BLEND_DST_A + RS_DESIRED]!;
    if (rs[RS_BLEND_SRC_RGB] !== srcRGB || rs[RS_BLEND_DST_RGB] !== dstRGB || rs[RS_BLEND_SRC_A] !== srcA || rs[RS_BLEND_DST_A] !== dstA) {
        gl.blendFuncSeparate(srcRGB, dstRGB, srcA, dstA);
        rs[RS_BLEND_SRC_RGB] = srcRGB;
        rs[RS_BLEND_DST_RGB] = dstRGB;
        rs[RS_BLEND_SRC_A] = srcA;
        rs[RS_BLEND_DST_A] = dstA;
    }
}
