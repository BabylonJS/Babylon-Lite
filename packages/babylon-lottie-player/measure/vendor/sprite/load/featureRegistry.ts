import { type LottieFeature, type LottieFeatureId } from "../features/feature";
import { type LottieFeatureConfig } from "../animationConfiguration";
import { type LottieSignals } from "./detectSignals";

/**
 * A self-describing, statically-known descriptor for one loadable Lottie feature. Each descriptor
 * pairs a pure detection predicate with the dynamic import that loads the feature's (potentially
 * heavy) implementation. Detection (`load/detectFeatures.ts`), runtime loading
 * (`load/loadFeatures.ts`), and the build-time artifact (Phase B) all consume this single registry,
 * so the question "is this feature needed?" is answered identically everywhere and the lists cannot
 * drift. The `matches` predicate is intentionally cheap: it reads the precomputed
 * {@link LottieSignals} rather than re-walking the animation.
 */
export type LottieFeatureDescriptor = {
    /** Unique feature identifier, also the order key for detection/loading. */
    id: LottieFeatureId;
    /**
     * Returns true when the precomputed signals (and engine-free configuration) require this feature.
     * Must be pure and Node-safe so the build-time codegen can call it.
     */
    matches(signals: LottieSignals, featureConfig: LottieFeatureConfig): boolean;
    /** Loads the feature's implementation module on demand. */
    loadAsync(): Promise<{ default: LottieFeature }>;
};

/**
 * The single source of truth for every loadable Lottie feature. Order defines the stable detection
 * and loading order. To add a feature, add one descriptor here; detection, loading, and build-time
 * codegen pick it up automatically.
 */
export const LottieFeatureRegistry: readonly LottieFeatureDescriptor[] = [
    {
        id: "solid",
        matches: (signals) => signals.layerTypes.has(1),
        loadAsync: async () => await import("../features/solid"),
    },
    {
        id: "shape",
        matches: (signals) => signals.layerTypes.has(4),
        loadAsync: async () => await import("../features/shape"),
    },
    {
        id: "text",
        matches: (signals) => signals.layerTypes.has(5),
        loadAsync: async () => await import("../features/text"),
    },
    {
        id: "shape-gradient",
        // Gradient fills (`gf`) and gradient strokes (`gs`) share one heavy gradient drawer that is
        // only loaded when an animation actually paints a gradient.
        matches: (signals) => signals.shapeItems.has("gf") || signals.shapeItems.has("gs"),
        loadAsync: async () => await import("../features/shapes/gradient"),
    },
] as const satisfies readonly LottieFeatureDescriptor[];

/**
 * Resolves the registry descriptor for a feature id.
 * @param id The feature id to look up.
 * @returns The matching descriptor.
 * @throws When no descriptor is registered for the id.
 */
export function GetFeatureDescriptor(id: LottieFeatureId): LottieFeatureDescriptor {
    for (let i = 0; i < LottieFeatureRegistry.length; i++) {
        if (LottieFeatureRegistry[i].id === id) {
            return LottieFeatureRegistry[i];
        }
    }
    throw new Error(`No Lottie feature descriptor registered for ${id}`);
}
