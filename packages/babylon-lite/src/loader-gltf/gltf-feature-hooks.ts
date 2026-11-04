import type { GltfFeature } from "./gltf-feature.js";

type FeatureGate = (json: any) => boolean;
type EnabledFeatures = (json: any, features: GltfFeature[]) => void;

let _enabled: EnabledFeatures | undefined;

/** @internal Register an explicitly enabled glTF feature without adding its semantics to the core loader. */
export function _registerEnabledGltfFeature(gate: FeatureGate, feature: GltfFeature): void {
    const previous = _enabled;
    _enabled = (json, features) => {
        previous?.(json, features);
        gate(json) && features.push(feature);
    };
}

/** @internal Append enabled features after the registry's content-triggered features resolve. */
export function _appendEnabledGltfFeatures(json: any, features: GltfFeature[]): void {
    _enabled?.(json, features);
}
