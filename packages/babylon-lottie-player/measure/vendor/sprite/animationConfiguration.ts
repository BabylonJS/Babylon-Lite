const MAX_SPRITE_ATLAS_SIZE = 8192;

/**
 * Configuration options for the Lottie animation player.
 */
export type AnimationConfiguration = {
    /**
     * Whether the animation should play on a loop or not
     */
    loopAnimation: boolean;
    /**
     * Width of the sprite atlas texture.
     * Set to 0 for auto-detection based on GPU capabilities (default).
     * Will use the minimum between GPU max texture size and 8192.
     */
    spriteAtlasWidth: number;
    /**
     * Height of the sprite atlas texture.
     * Set to 0 for auto-detection based on GPU capabilities (default).
     * Will use the minimum between GPU max texture size and 8192.
     */
    spriteAtlasHeight: number;
    /**
     * Gap size around sprites in the atlas.
     * Default is 5.
     */
    gapSize: number;
    /**
     * Maximum number of sprites the renderer can handle at once.
     * Default is 64.
     */
    spritesCapacity: number;
    /**
     * Background color for the animation canvas.
     * Default is white with full opacity.
     */
    backgroundColor: { r: number; g: number; b: number; a: number };
    /**
     * Minimum scale factor to prevent too small sprites.
     * Default is 5.
     */
    scaleMultiplier: number;
    /**
     * Scale factor for the rendering.
     * Set to 0 for auto-detection based on atlas size (default).
     * Uses 4x supersampling for 8K atlas, 2x for smaller atlases.
     */
    devicePixelRatio: number;
    /**
     * Number of steps to sample cubic bezier easing functions for animations.
     * Default is 4.
     */
    easingSteps: number;
    /**
     * Whether to support device lost events for WebGL contexts.
     * Default is false.
     */
    supportDeviceLost: boolean;
    /**
     * When set, the animation will play normally but stop at this frame number.
     * Useful for visual testing of animations at specific points in time.
     * Default is undefined (play the full animation).
     */
    stopAtFrame?: number;
};

/**
 * Fully resolved configuration used internally by the Lottie animation player.
 */
export type LottieFeatureConfig = {
    /** Whether the animation should play on a loop or not. */
    loopAnimation: boolean;
    /** Number of steps to sample cubic bezier easing functions for animations. */
    easingSteps: number;
    /** Whether to support device lost events for WebGL contexts. */
    supportDeviceLost: boolean;
    /** When set, the animation will play normally but stop at this frame number. */
    stopAtFrame?: number;
};

/**
 * Renderer-bound configuration resolved after a rendering engine is available.
 */
export type LottieRendererConfig = {
    /** Width of the sprite atlas texture. */
    spriteAtlasWidth: number;
    /** Height of the sprite atlas texture. */
    spriteAtlasHeight: number;
    /** Gap size around sprites in the atlas. */
    gapSize: number;
    /** Maximum number of sprites the renderer can handle at once. */
    spritesCapacity: number;
    /** Background color for the animation canvas. */
    backgroundColor: { r: number; g: number; b: number; a: number };
    /** Minimum scale factor to prevent too small sprites. */
    scaleMultiplier: number;
    /** Scale factor for the rendering. */
    devicePixelRatio: number;
};

/**
 * Fully resolved configuration used internally by existing Lottie player code paths.
 */
export type ResolvedAnimationConfiguration = LottieFeatureConfig & LottieRendererConfig;

/**
 * Default engine-free feature configuration for lottie animations playback.
 */
export const DefaultFeatureConfiguration: LottieFeatureConfig = {
    loopAnimation: false, // By default do not loop animations
    easingSteps: 4, // Number of steps to sample easing functions for animations - Less than 4 causes issues with some interpolations
    supportDeviceLost: true, // Whether to support device lost events for WebGL contexts,
};

/**
 * Default renderer-bound configuration for lottie animations playback.
 */
export const DefaultRendererConfiguration: LottieRendererConfig = {
    spriteAtlasWidth: 0, // 0 = auto-detect based on GPU capabilities
    spriteAtlasHeight: 0, // 0 = auto-detect based on GPU capabilities
    gapSize: 25, // Gap around the sprites in the atlas
    spritesCapacity: 64, // Maximum number of sprites the renderer can handle at once
    backgroundColor: { r: 0, g: 0, b: 0, a: 1 }, // Background color for the animation canvas
    scaleMultiplier: 5, // Minimum scale factor to prevent too small sprites,
    devicePixelRatio: 0, // 0 = auto-detect based on atlas size
};

/**
 * Default configuration for lottie animations playback.
 */
export const DefaultConfiguration: ResolvedAnimationConfiguration = {
    ...DefaultFeatureConfiguration,
    ...DefaultRendererConfiguration,
};

/**
 * Resolves engine-free feature configuration before a rendering engine exists.
 * @param newConfig The configuration passed by the client.
 * @returns The resolved feature configuration.
 */
export function ResolveFeatureConfiguration(newConfig: Partial<AnimationConfiguration>): LottieFeatureConfig {
    const config: LottieFeatureConfig = {
        loopAnimation: newConfig.loopAnimation ?? DefaultFeatureConfiguration.loopAnimation,
        easingSteps: newConfig.easingSteps ?? DefaultFeatureConfiguration.easingSteps,
        supportDeviceLost: newConfig.supportDeviceLost ?? DefaultFeatureConfiguration.supportDeviceLost,
    };

    if (newConfig.stopAtFrame !== undefined) {
        config.stopAtFrame = newConfig.stopAtFrame;
    }

    return config;
}

/**
 * Resolves renderer-bound configuration after GPU capabilities are available.
 * @param newConfig The configuration passed by the client.
 * @param maxTextureSize The maximum texture size supported by the GPU.
 * @param mainThreadDevicePixelRatio The devicePixelRatio from the main thread (used in worker scenarios where window is not available).
 * @returns The resolved renderer configuration.
 */
export function ResolveRendererConfiguration(newConfig: Partial<AnimationConfiguration>, maxTextureSize: number, mainThreadDevicePixelRatio?: number): LottieRendererConfig {
    const optimalAtlasSize = Math.min(maxTextureSize, MAX_SPRITE_ATLAS_SIZE);

    let spriteAtlasWidth = newConfig.spriteAtlasWidth ?? DefaultRendererConfiguration.spriteAtlasWidth;
    let spriteAtlasHeight = newConfig.spriteAtlasHeight ?? DefaultRendererConfiguration.spriteAtlasHeight;
    if (spriteAtlasHeight === 0 || spriteAtlasWidth === 0) {
        spriteAtlasWidth = optimalAtlasSize;
        spriteAtlasHeight = optimalAtlasSize;
    }

    let devicePixelRatio = newConfig.devicePixelRatio ?? DefaultRendererConfiguration.devicePixelRatio;
    if (devicePixelRatio === 0) {
        const systemDpr = mainThreadDevicePixelRatio ?? (typeof window !== "undefined" ? window.devicePixelRatio : 1);
        devicePixelRatio = optimalAtlasSize >= MAX_SPRITE_ATLAS_SIZE ? Math.max(systemDpr, 4) : Math.max(systemDpr, 2);
    }

    return {
        spriteAtlasWidth,
        spriteAtlasHeight,
        gapSize: newConfig.gapSize ?? DefaultRendererConfiguration.gapSize,
        spritesCapacity: newConfig.spritesCapacity ?? DefaultRendererConfiguration.spritesCapacity,
        backgroundColor: newConfig.backgroundColor ?? DefaultRendererConfiguration.backgroundColor,
        scaleMultiplier: newConfig.scaleMultiplier ?? DefaultRendererConfiguration.scaleMultiplier,
        devicePixelRatio,
    };
}

/**
 * Creates the final animation configuration by merging the provided partial configuration with the default configuration.
 * Computes optimal atlas size and devicePixelRatio based on GPU capabilities when not explicitly provided.
 * @param newConfig The configuration passed by the client.
 * @param maxTextureSize The maximum texture size supported by the GPU.
 * @param mainThreadDevicePixelRatio The devicePixelRatio from the main thread (used in worker scenarios where window is not available).
 * @returns The final animation configuration.
 */
export function UpdateConfiguration(newConfig: Partial<AnimationConfiguration>, maxTextureSize: number, mainThreadDevicePixelRatio?: number): ResolvedAnimationConfiguration {
    return {
        ...ResolveFeatureConfiguration(newConfig),
        ...ResolveRendererConfiguration(newConfig, maxTextureSize, mainThreadDevicePixelRatio),
    };
}
