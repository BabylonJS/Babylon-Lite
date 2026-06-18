/**
 * Babylon.js engine-level enums and constant bags that scenes import for their
 * numeric values. These carry no behaviour in the compat layer — they exist so
 * that code reading `ScenePerformancePriority.Aggressive`,
 * `ImageProcessingConfiguration.TONEMAPPING_ACES`, or
 * `Constants.MATERIAL_CounterClockWiseSideOrientation` resolves to the same
 * numbers Babylon.js uses.
 */

/** Babylon.js `ScenePerformancePriority`. */
export enum ScenePerformancePriority {
    BackwardCompatible = 0,
    Intermediate = 1,
    Aggressive = 2,
}

/**
 * Babylon.js `ShaderLanguage` — the shader-source language selector. Babylon Lite
 * is WGSL-only, but the enum is surfaced (with Babylon.js's numeric values) so
 * scenes that import it to author `WGSL` shaders resolve the symbol; a `GLSL`
 * `ShaderMaterial`/`EffectWrapper` still fails loudly at construction.
 */
export enum ShaderLanguage {
    GLSL = 0,
    WGSL = 1,
}

/**
 * Babylon.js `ImageProcessingConfiguration` — only the tone-mapping constants are
 * surfaced (the live exposure/contrast/tone-mapping toggle is exposed through
 * `scene.imageProcessingConfiguration`).
 */
export class ImageProcessingConfiguration {
    public static readonly TONEMAPPING_STANDARD = 0;
    public static readonly TONEMAPPING_ACES = 1;
    public static readonly TONEMAPPING_KHR_PBR_NEUTRAL = 2;
}

/**
 * Babylon.js `Constants` — the small subset of numeric constants referenced by
 * the ported scenes. Extend as needed.
 */
export const Constants = {
    MATERIAL_ClockWiseSideOrientation: 0,
    MATERIAL_CounterClockWiseSideOrientation: 1,
    MATERIAL_TriangleFillMode: 0,
    MATERIAL_WireFrameFillMode: 1,
    MATERIAL_PointFillMode: 2,
    ALPHA_DISABLE: 0,
    ALPHA_ADD: 1,
    ALPHA_COMBINE: 2,
    ALPHA_ONEONE: 6,
    ALPHA_PREMULTIPLIED: 7,
    MATERIAL_OPAQUE: 0,
    MATERIAL_ALPHATEST: 1,
    MATERIAL_ALPHABLEND: 2,
    TEXTURE_CLAMP_ADDRESSMODE: 0,
    TEXTURE_WRAP_ADDRESSMODE: 1,
    TEXTURE_MIRROR_ADDRESSMODE: 2,
} as const;
