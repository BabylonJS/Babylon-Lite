/** glTF KHR_materials_anisotropy extension. */
import type { GltfFeature } from "./gltf-feature.js";

const ext: GltfFeature = {
    id: "KHR_materials_anisotropy",
    async applyMaterial(mat) {
        const a = mat._rawMatDef?.extensions?.KHR_materials_anisotropy;
        if (!a) {
            return null;
        }
        const rot = a.anisotropyRotation ?? 0;
        return {
            anisotropy: {
                isEnabled: true,
                intensity: a.anisotropyStrength ?? 0,
                direction: [Math.cos(rot), Math.sin(rot)],
            },
        };
    },
};
export default ext;
