import { type LottieFeatureId } from "./feature";

/**
 * Single source of truth mapping a Lottie layer type number to the feature that owns it.
 * Both feature detection (`load/detectFeatures.ts`) and layer dispatch (`parsing/buildAnimation.ts`)
 * consume this table so a new feature is registered in exactly one place and the two cannot drift.
 * Null layers (ty:3) are structural and owned by no feature, so they do not appear here.
 */
export const LayerTypeFeatureTable = [
    { layerType: 1, featureId: "solid" },
    { layerType: 4, featureId: "shape" },
    { layerType: 5, featureId: "text" },
] as const satisfies ReadonlyArray<{ layerType: number; featureId: LottieFeatureId }>;

/**
 * Resolves the feature that owns a Lottie layer type.
 * @param layerType The Lottie layer type number.
 * @returns The owning feature id, or undefined when no feature owns the type.
 */
export function GetFeatureIdForLayerType(layerType: number): LottieFeatureId | undefined {
    for (let i = 0; i < LayerTypeFeatureTable.length; i++) {
        if (LayerTypeFeatureTable[i].layerType === layerType) {
            return LayerTypeFeatureTable[i].featureId;
        }
    }
    return undefined;
}
