/**
 * Lazy, null-by-default registry hook for the opt-in sprite coverage-gamma feature.
 *
 * Coverage gamma raises a glyph-atlas layer's sampled alpha to `1/coverageGamma` in the
 * fragment stage (text "stem darkening"). It is a value-driven feature, so — unlike the
 * custom-shader hook whose impl module is pulled in by importing `createSprite2DCustomShader`
 * — its trigger is `setSprite2DCoverageGamma`. Importing that setter registers this hook and
 * drags in the gamma shader permutation, the `aa.x` UBO write, and the pipeline-key part.
 *
 * The always-loaded sprite pipeline reaches the feature exclusively through these hook methods
 * and never names the layer's internal `_coverageGamma` value, so a sprite scene that never imports
 * the setter keeps the hook `null` and carries zero gamma bytes — mirroring `sprite-fx-hook.ts`.
 *
 * No module-level side effects: the hook slot is a plain nullable `let`; registration is explicit.
 */
import type { EngineContext } from "../engine/engine.js";
import type { Sprite2DLayer } from "./sprite-2d.js";

/** @internal Opt-in sprite coverage-gamma hook. The impl reads the layer's internal `_coverageGamma` value. */
export interface SpriteCoverageGammaHook {
    /** Pipeline-cache key part for `layer` (`"1"` for a gamma layer, `"0"` otherwise). */
    pipelineKeyPart(layer: Sprite2DLayer): string;
    /** Coverage-gamma sprite shader module for `layer`, or `null` to fall back to the base shader. */
    shaderModule(engine: EngineContext, hasDepth: boolean, layer: Sprite2DLayer): GPUShaderModule | null;
    /** Write the gamma slice (`aa.x = 1/coverageGamma`) of the layer UBO. Deterministic for every layer. */
    writeUbo(layer: Sprite2DLayer, ubo: Float32Array): void;
}

let _coverageGammaHook: SpriteCoverageGammaHook | null = null;

/** @internal Register the sprite coverage-gamma hook. Idempotent; called by `setSprite2DCoverageGamma`. */
export function _registerSpriteCoverageGammaHook(hook: SpriteCoverageGammaHook): void {
    _coverageGammaHook = hook;
}

/** @internal The registered sprite coverage-gamma hook, or `null` when no gamma layer exists. */
export function _getSpriteCoverageGammaHook(): SpriteCoverageGammaHook | null {
    return _coverageGammaHook;
}
