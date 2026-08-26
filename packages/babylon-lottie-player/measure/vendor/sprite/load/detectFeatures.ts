import { type LottieFeatureId } from "../features/feature";
import { type LottieFeatureConfig } from "../animationConfiguration";
import { type RawLottieAnimation } from "../parsing/rawTypes";
import { DetectLottieSignals } from "./detectSignals";
import { LottieFeatureRegistry } from "./featureRegistry";

/**
 * Detects which Lottie feature modules are required by the raw animation data and engine-free configuration.
 * Runs a single detection pass to gather every signal, then matches each registry descriptor against it,
 * so detection cost is one walk of the animation regardless of how many features exist.
 * @param raw Raw Lottie animation data.
 * @param featureConfig Engine-free feature configuration.
 * @returns Stable ordered list of required feature ids.
 */
export function DetectLottieFeatures(raw: RawLottieAnimation, featureConfig: LottieFeatureConfig): LottieFeatureId[] {
    const signals = DetectLottieSignals(raw);
    const features: LottieFeatureId[] = [];

    for (let i = 0; i < LottieFeatureRegistry.length; i++) {
        const descriptor = LottieFeatureRegistry[i];
        if (descriptor.matches(signals, featureConfig)) {
            features.push(descriptor.id);
        }
    }

    return features;
}

export { DetectLottieFeatures as detectLottieFeatures };
