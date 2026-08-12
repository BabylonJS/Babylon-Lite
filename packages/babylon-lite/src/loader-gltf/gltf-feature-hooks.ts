import type { GltfFeature } from "./gltf-feature.js";

type FeatureGate = (json: any) => boolean;
type EnabledFeatures = (json: any, features?: GltfFeature[]) => boolean;

let _enabled: EnabledFeatures | undefined;

/** @internal Register an explicitly enabled glTF feature without adding its semantics to the core loader. */
export function _registerEnabledGltfFeature(gate: FeatureGate, feature: GltfFeature): void {
    const previous = _enabled;
    _enabled = (json, features) => {
        const active = gate(json);
        if (active && features) {
            features.push(feature);
        }
        return !!previous?.(json, features) || active;
    };
}

/** @internal Cheap core-loader gate. Folds to false when no public enabler is imported. */
export function _hasEnabledGltfFeature(json: any): boolean {
    return !!_enabled?.(json);
}

/** @internal Append enabled features after the registry's content-triggered features resolve. */
export function _appendEnabledGltfFeatures(json: any, features: GltfFeature[]): void {
    _enabled?.(json, features);
}
