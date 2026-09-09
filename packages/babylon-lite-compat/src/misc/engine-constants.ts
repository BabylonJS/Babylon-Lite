/**
 * Babylon.js engine-level enums and constant bags that scenes import for their
 * numeric values. These carry no behaviour in the compat layer — they exist so
 * that code reading `ScenePerformancePriority.Aggressive`,
 * `ImageProcessingConfiguration.TONEMAPPING_ACES`, or
 * `Constants.MATERIAL_CounterClockWiseSideOrientation` resolves to the same
 * numbers Babylon.js uses.
 */

import { unsupported } from "../error.js";

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
 * Minimal Babylon.js `ImageProcessingConfiguration` facade over Lite's image
 * processing state.
 */
export class ImageProcessingConfiguration {
    public static readonly TONEMAPPING_STANDARD = 0;
    public static readonly TONEMAPPING_ACES = 1;
    public static readonly TONEMAPPING_KHR_PBR_NEUTRAL = 2;

    private _backing: {
        exposure: number;
        contrast: number;
        toneMappingEnabled: boolean;
    } = {
        exposure: 1,
        contrast: 1,
        toneMappingEnabled: false,
    };

    /** @internal Attach this facade to a scene's Babylon Lite state. */
    public _attach(backing: { exposure: number; contrast: number; toneMappingEnabled: boolean }): this {
        this._backing = backing;
        return this;
    }

    public get exposure(): number {
        return this._backing.exposure;
    }
    public set exposure(value: number) {
        this._backing.exposure = value;
    }

    public get contrast(): number {
        return this._backing.contrast;
    }
    public set contrast(value: number) {
        this._backing.contrast = value;
    }

    public get toneMappingEnabled(): boolean {
        return this._backing.toneMappingEnabled;
    }
    public set toneMappingEnabled(value: boolean) {
        this._backing.toneMappingEnabled = value;
    }

    public get whiteBalanceEnabled(): boolean {
        return false;
    }
    public set whiteBalanceEnabled(value: boolean) {
        if (value) {
            unsupported("ImageProcessingConfiguration.whiteBalanceEnabled", WHITE_BALANCE_UNSUPPORTED);
        }
    }

    public get temperature(): number {
        return 6500;
    }
    public set temperature(value: number) {
        if (value !== 6500) {
            unsupported("ImageProcessingConfiguration.temperature", WHITE_BALANCE_UNSUPPORTED);
        }
    }

    public get tint(): number {
        return 0;
    }
    public set tint(value: number) {
        if (value !== 0) {
            unsupported("ImageProcessingConfiguration.tint", WHITE_BALANCE_UNSUPPORTED);
        }
    }
}

const WHITE_BALANCE_UNSUPPORTED =
    "White balance requires color-temperature math, a shader uniform, material/post-process defines, and pipeline invalidation that Babylon Lite does not expose; adding it needs a cross-cutting Lite subsystem design.";

/** Babylon.js pure-module registration hook. */
export function RegisterImageProcessingConfiguration(): void {
    return unsupported("RegisterImageProcessingConfiguration", "Babylon Lite has no Babylon.js SerializationHelper parser registry to install ImageProcessingConfiguration into.");
}

/**
 * Babylon.js pure-module texture-loader registration hook. Lite dispatches its
 * supported texture formats directly, so no registration is required.
 */
export function RegisterAbstractEngineTextureLoaders(): void {}

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
    ALPHA_REPLACE_COLOR: 21,
    MATERIAL_OPAQUE: 0,
    MATERIAL_ALPHATEST: 1,
    MATERIAL_ALPHABLEND: 2,
    TEXTURE_CLAMP_ADDRESSMODE: 0,
    TEXTURE_WRAP_ADDRESSMODE: 1,
    TEXTURE_MIRROR_ADDRESSMODE: 2,
    TEXTURE_NEAREST_SAMPLINGMODE: 1,
    TEXTURE_BILINEAR_SAMPLINGMODE: 2,
    TEXTURE_TRILINEAR_SAMPLINGMODE: 3,
    TEXTUREFORMAT_RGBA: 5,
    TEXTURETYPE_UNSIGNED_BYTE: 0,
} as const;
