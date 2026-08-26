import { type RawElement, type RawLottieAnimation } from "../parsing/rawTypes";
import { CollectShapeDrawItems, type ShapeDrawItemType } from "./detectShapeItems";

/**
 * The set of detectable signals present in a raw Lottie animation. Computed in a single pass so every
 * feature descriptor can be matched without re-walking the animation, and so the runtime hot path and
 * the build-time codegen (which both consume this) observe identical signals.
 */
export type LottieSignals = {
    /** Lottie layer `ty` values present on visible (non-hidden) layers. */
    layerTypes: ReadonlySet<number>;
    /** Drawing sub-feature shape-item `ty` values present on visible shape items. */
    shapeItems: ReadonlySet<ShapeDrawItemType>;
};

/**
 * Scans a raw Lottie animation once and reports every detectable signal: which layer types are
 * present and which shape-item drawing sub-features are used. Hidden layers and hidden shape items
 * (`hd === true`) are skipped. The function is pure and Node-safe so it can run on the runtime load
 * path and ahead of time in a build step.
 * @param raw Raw Lottie animation data.
 * @returns The detected signals for the animation.
 */
export function DetectLottieSignals(raw: RawLottieAnimation): LottieSignals {
    const layerTypes = new Set<number>();
    const shapeItems = new Set<ShapeDrawItemType>();

    for (let i = 0; i < raw.layers.length; i++) {
        const layer = raw.layers[i];
        if (layer.hd === true) {
            continue;
        }
        layerTypes.add(layer.ty);
        // Only shape layers (ty:4) carry a `shapes` array of drawable items.
        if (layer.ty === 4) {
            const shapeLayer = layer as { shapes?: RawElement[] };
            CollectShapeDrawItems(shapeLayer.shapes, shapeItems);
        }
    }

    return { layerTypes, shapeItems };
}

export { DetectLottieSignals as detectLottieSignals };
