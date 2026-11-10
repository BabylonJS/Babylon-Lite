/**
 * Native blend module — the native-backend twin of `blend.ts`. Mirrors its
 * PUBLIC API (GLBlendMode / GLBlendEquation / setBlendMode / setBlendState /
 * disableBlend) with the same deferred model (record desired, flush before draw
 * via native-apply-states).
 *
 * NATIVE DIVERGENCE: Babylon Native exposes only PRESET blend factors
 * (`COMMAND_SETBLENDMODE` with an `ALPHA_*` enum) and ONE global equation
 * (`COMMAND_SETBLENDEQUATION`, newer hosts only), not WebGL's arbitrary separate
 * src/dst/equation functions. {@link setBlendState} is exact for every factor
 * combination that matches a host preset and approximated otherwise — see its note.
 */
import type { GLEngineContext } from "./native-context.js";
import { dSetBlendEquation, dSetBlendMode, nativeAlphaMode } from "./native-device.js";

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

/** Blend equations — same values as the WebGL module (the GL enums). Applied on
 *  hosts exposing `COMMAND_SETBLENDEQUATION`; older hosts always add. */
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
 *  On native it maps to a host preset (see {@link setBlendState}). */
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

/** WebGL blend-factor enums. */
const GL_ZERO = 0;
const GL_ONE = 1;
const GL_ONE_MINUS_SRC_COLOR = 0x0301;
const GL_SRC_ALPHA = 0x0302;
const GL_ONE_MINUS_SRC_ALPHA = 0x0303;
const GL_DST_COLOR = 0x0306;

/** Fold a GL blend factor into 12 bits: `ZERO`/`ONE`/`0x03xx` stay as-is, the
 *  constant-color factors (`0x8001`-`0x8004`) move to `0x0401`-`0x0404`. */
function factorBits(factor: number): number {
    return factor >= 0x8000 ? factor - 0x8000 + 0x0400 : factor;
}

/** Pack four GL blend factors into one exact numeric key (48 bits). */
function factorKey(srcRGB: number, dstRGB: number, srcAlpha: number, dstAlpha: number): number {
    return ((factorBits(srcRGB) * 4096 + factorBits(dstRGB)) * 4096 + factorBits(srcAlpha)) * 4096 + factorBits(dstAlpha);
}

/** Host presets keyed by their exact `(srcRGB, dstRGB, srcAlpha, dstAlpha)`
 *  factors, and by their RGB factors alone (first preset wins) for the nearest
 *  match. Built lazily — the host statics are only readable at runtime — and
 *  rebuilt if the host's `Engine` constructor changes (re-installed host). */
let presetsHost: unknown;
let presetsByFactors: Map<number, number> | undefined;
let presetsByRGB: Map<number, number> | undefined;

function buildPresetTables(): void {
    const E = _native.Engine;
    presetsHost = E;
    // Factors mirror the host's AlphaMode table (NativeEngine.cpp). Order sets the
    // RGB-only fallback priority.
    const presets: [number, number, number, number, number | undefined][] = [
        [GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA, GL_ONE, GL_ONE, E.ALPHA_COMBINE],
        [GL_ONE, GL_ONE_MINUS_SRC_ALPHA, GL_ONE, GL_ONE, E.ALPHA_PREMULTIPLIED],
        [GL_SRC_ALPHA, GL_ONE, GL_ZERO, GL_ONE, E.ALPHA_ADD],
        [GL_ZERO, GL_ONE_MINUS_SRC_COLOR, GL_ONE, GL_ONE, E.ALPHA_SUBTRACT],
        [GL_DST_COLOR, GL_ZERO, GL_ONE, GL_ONE, E.ALPHA_MULTIPLY],
        [GL_SRC_ALPHA, GL_ONE_MINUS_SRC_COLOR, GL_ONE, GL_ONE, E.ALPHA_MAXIMIZED],
        [GL_ONE, GL_ONE, GL_ZERO, GL_ONE, E.ALPHA_ONEONE],
        [GL_ONE, GL_ONE, GL_ONE, GL_ONE, E.ALPHA_ONEONE_ONEONE],
        [GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA, GL_ONE, GL_ONE_MINUS_SRC_ALPHA, E.ALPHA_LAYER_ACCUMULATE],
        [GL_ONE, GL_ONE_MINUS_SRC_ALPHA, GL_ONE, GL_ONE_MINUS_SRC_ALPHA, E.ALPHA_PREMULTIPLIED_PORTERDUFF],
        [GL_ONE, GL_ONE_MINUS_SRC_COLOR, GL_ONE, GL_ONE_MINUS_SRC_ALPHA, E.ALPHA_SCREENMODE],
    ];
    presetsByFactors = new Map();
    presetsByRGB = new Map();
    for (const [srcRGB, dstRGB, srcAlpha, dstAlpha, mode] of presets) {
        // Presets added after the host's first release are absent on older hosts.
        if (mode === undefined) {
            continue;
        }
        presetsByFactors.set(factorKey(srcRGB, dstRGB, srcAlpha, dstAlpha), mode);
        const rgbKey = factorKey(srcRGB, dstRGB, 0, 0);
        if (!presetsByRGB.has(rgbKey)) {
            presetsByRGB.set(rgbKey, mode);
        }
    }
}

/** Map GL blend factors to a native `ALPHA_*` preset: the exact preset when one
 *  exists, else the first preset with the same RGB factors, else COMBINE. */
function nativePresetFor(state: GLBlendState): number {
    if (presetsHost !== _native.Engine) {
        buildPresetTables();
    }
    return (
        presetsByFactors!.get(factorKey(state.srcRGB, state.dstRGB, state.srcAlpha, state.dstAlpha)) ??
        presetsByRGB!.get(factorKey(state.srcRGB, state.dstRGB, 0, 0)) ??
        _native.Engine.ALPHA_COMBINE
    );
}

/** Map a GL `(equationRGB, equationAlpha)` pair to a native `ALPHA_EQUATION_*`.
 *  The host applies one equation to both channels, except DARKEN (MIN for RGB,
 *  ADD for alpha); other mixed pairs use the RGB equation for both. Returns
 *  `-1` on hosts without blend-equation support. */
function nativeEquationFor(eqRGB: number, eqAlpha: number): number {
    const E = _native.Engine;
    if (E.COMMAND_SETBLENDEQUATION === undefined) {
        return -1;
    }
    switch (eqRGB) {
        case GLBlendEquation.SUBTRACT:
            return E.ALPHA_EQUATION_SUBTRACT ?? -1;
        case GLBlendEquation.REVERSE_SUBTRACT:
            return E.ALPHA_EQUATION_REVERSE_SUBTRACT ?? -1;
        case GLBlendEquation.MAX:
            return E.ALPHA_EQUATION_MAX ?? -1;
        case GLBlendEquation.MIN:
            return (eqAlpha === GLBlendEquation.ADD ? E.ALPHA_EQUATION_DARKEN : E.ALPHA_EQUATION_MIN) ?? -1;
        default:
            return E.ALPHA_EQUATION_ADD ?? -1;
    }
}

/**
 * Set a blend preset (deferred; flushed before the next native draw). Mirrors the
 * WebGL `setBlendMode` (every preset blends with FUNC_ADD).
 */
export function setBlendMode(engine: GLEngineContext, mode: GLBlendMode): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    recordBlend(engine, nativeAlphaMode(mode), nativeEquationFor(GLBlendEquation.ADD, GLBlendEquation.ADD));
}

/**
 * Set an arbitrary separate-channel blend (deferred). Mirrors the WebGL
 * `setBlendState`.
 *
 * NATIVE: factors map EXACTLY when they match a host preset — `ALPHA_ADD`
 * (`SRC_ALPHA`, `ONE`, `ZERO`, `ONE`), `ALPHA_COMBINE` (`SRC_ALPHA`,
 * `ONE_MINUS_SRC_ALPHA`, `ONE`, `ONE`), `ALPHA_PREMULTIPLIED` (`ONE`,
 * `ONE_MINUS_SRC_ALPHA`, `ONE`, `ONE`),
 * `ALPHA_PREMULTIPLIED_PORTERDUFF`, `ALPHA_SUBTRACT`, `ALPHA_MULTIPLY`,
 * `ALPHA_MAXIMIZED`, `ALPHA_ONEONE`, `ALPHA_SCREENMODE`, and on newer hosts
 * `ALPHA_ONEONE_ONEONE` / `ALPHA_LAYER_ACCUMULATE`. Any other combination falls
 * back to the first preset with the same RGB factors, else `ALPHA_COMBINE`.
 * Equations need a host with `COMMAND_SETBLENDEQUATION` (one equation for both
 * channels, plus MIN-RGB / ADD-alpha); older hosts always add.
 */
export function setBlendState(engine: GLEngineContext, state: GLBlendState): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    recordBlend(engine, nativePresetFor(state), nativeEquationFor(state.equationRGB ?? GLBlendEquation.ADD, state.equationAlpha ?? GLBlendEquation.ADD));
}

/** Disable blending (deferred). Mirrors the WebGL `disableBlend`. */
export function disableBlend(engine: GLEngineContext): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const s = engine._state;
    // The equation is unobservable while blending is off; keep its desired value
    // so a later enable with the same equation re-issues nothing (as WebGL).
    recordBlend(engine, _native.Engine.ALPHA_DISABLE, s.blendEquationDesired);
}

/** Record the desired native preset + equation and install the reconciler. */
function recordBlend(engine: GLEngineContext, nativeMode: number, nativeEquation: number): void {
    const s = engine._state;
    s.blendModeDesired = nativeMode;
    s.blendEquationDesired = nativeEquation;
    s._flushBlend = flushBlend;
    s.statesDirty = true;
}

/**
 * Reconcile the desired blend preset + equation → actual, emitting
 * `COMMAND_SETBLENDMODE` / `COMMAND_SETBLENDEQUATION` only when they changed.
 * Installed on `_state._flushBlend`; dispatched by `applyNativeStates`. @internal
 */
function flushBlend(engine: GLEngineContext): void {
    const s = engine._state;
    if (s.blendModeDesired === -1) {
        return;
    }
    if (s.blendModeDesired !== s.blendModeActual) {
        s.blendModeActual = s.blendModeDesired;
        dSetBlendMode(engine, s.blendModeDesired);
    }
    if (s.blendModeDesired !== _native.Engine.ALPHA_DISABLE && s.blendEquationDesired !== -1 && s.blendEquationDesired !== s.blendEquationActual) {
        s.blendEquationActual = s.blendEquationDesired;
        dSetBlendEquation(engine, s.blendEquationDesired);
    }
}
