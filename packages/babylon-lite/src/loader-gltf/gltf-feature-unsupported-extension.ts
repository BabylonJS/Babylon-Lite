import type { GltfFeature } from "./gltf-feature.js";
import { _registerEnabledGltfFeature } from "./gltf-feature-hooks.js";

/** Register an opt-in material-extension guard that fails only when an asset uses the named extension. */
export function enableUnsupportedGltfMaterialExtension(extensionName: string, fail: () => never): void {
    const feature: GltfFeature = {
        id: extensionName,
        async applyMaterial(material) {
            if (material._rawMatDef?.extensions?.[extensionName]) {
                fail();
            }
            return null;
        },
    };
    _registerEnabledGltfFeature((json) => json.extensionsUsed?.includes(extensionName) === true, feature);
}
