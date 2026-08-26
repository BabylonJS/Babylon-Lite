import { type AnimationInfo } from "../parsing/parsedTypes";
import { type LottieFeatureSet } from "../features/feature";
import { type LottieFeatureConfig, type LottieRendererConfig } from "../animationConfiguration";
import { type RawLottieAnimation } from "../parsing/rawTypes";
import { type RenderingManager } from "../rendering/renderingManager";
import { BuildAnimation } from "../parsing/buildAnimation";
import { type SpritePacker } from "../parsing/spritePacker";
import { MaterializeSpriteRecords } from "../rendering/babylonSpriteAdapter";

export type ParseAnimationContext = {
    /** Object that packs animation sprites into texture atlases. */
    packer: SpritePacker;
    /** Object that receives sprites produced by parsing. */
    renderingManager: RenderingManager;
};

function ValidateFeatureSet(features: LottieFeatureSet | undefined): void {
    if (features === undefined) {
        return;
    }

    for (let i = 0; i < features.features.length; i++) {
        if (features.features[i].id !== features.ids[i]) {
            throw new Error(`Loaded Lottie feature ${features.features[i].id} did not match detected feature ${features.ids[i]}`);
        }
    }
}

/**
 * Parses an animation using an explicit, already loaded feature set.
 * The parser receives the loaded feature set so extracted layer handlers can stay behind their feature chunks.
 * @param raw Raw Lottie animation data.
 * @param features Loaded feature set for this animation.
 * @param featureConfig Engine-free feature configuration.
 * @param rendererConfig Renderer-bound configuration.
 * @param context Parser dependencies supplied by the current Babylon renderer path.
 * @returns Parsed animation information.
 */
export function ParseAnimation(
    raw: RawLottieAnimation,
    features: LottieFeatureSet | undefined,
    featureConfig: LottieFeatureConfig,
    rendererConfig: LottieRendererConfig,
    context: ParseAnimationContext
): AnimationInfo {
    ValidateFeatureSet(features);

    const built = BuildAnimation(raw, context.packer, featureConfig, rendererConfig, features);

    // Materialize the renderer-agnostic sprite records into Babylon sprites and finalize the renderer.
    MaterializeSpriteRecords(built.spriteRecords, context.packer, context.renderingManager);

    return built.animationInfo;
}

/**
 * Parses an animation using an explicit, already loaded feature set.
 * The parser receives the loaded feature set so extracted layer handlers can stay behind their feature chunks.
 * @param raw Raw Lottie animation data.
 * @param features Loaded feature set for this animation.
 * @param featureConfig Engine-free feature configuration.
 * @param rendererConfig Renderer-bound configuration.
 * @param context Parser dependencies supplied by the current Babylon renderer path.
 * @returns Parsed animation information.
 */
export async function ParseAnimationAsync(
    raw: RawLottieAnimation,
    features: LottieFeatureSet,
    featureConfig: LottieFeatureConfig,
    rendererConfig: LottieRendererConfig,
    context: ParseAnimationContext
): Promise<AnimationInfo> {
    return ParseAnimation(raw, features, featureConfig, rendererConfig, context);
}

export { ParseAnimation as parseAnimation, ParseAnimationAsync as parseAnimationAsync };
