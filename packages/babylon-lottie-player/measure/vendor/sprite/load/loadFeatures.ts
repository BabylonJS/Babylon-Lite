import { type LottieFeature, type LottieFeatureSet } from "../features/feature";
import { type LottieFeatureConfig } from "../animationConfiguration";
import { type RawLottieAnimation } from "../parsing/rawTypes";
import { DetectLottieFeatures } from "./detectFeatures";
import { GetFeatureDescriptor } from "./featureRegistry";

type LottieFeatureModule = { default: LottieFeature };

/**
 * Loads the feature modules required by one animation using explicit runtime detection.
 * @param raw Raw Lottie animation data.
 * @param featureConfig Engine-free feature configuration.
 * @returns Loaded feature set in detection order.
 */
export async function LoadLottieFeatures(raw: RawLottieAnimation, featureConfig: LottieFeatureConfig): Promise<LottieFeatureSet> {
    const ids = DetectLottieFeatures(raw, featureConfig);
    const featurePromises: Promise<LottieFeatureModule>[] = [];

    for (let i = 0; i < ids.length; i++) {
        featurePromises.push(GetFeatureDescriptor(ids[i]).loadAsync());
    }

    const modules = await Promise.all(featurePromises);
    const features = modules.map((module) => module.default);
    return { ids, features };
}

export { LoadLottieFeatures as loadLottieFeatures };
