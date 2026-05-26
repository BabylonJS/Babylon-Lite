/** glTF KHR_materials_emissive_strength extension.
 *  Multiplies the material's emissiveFactor by `emissiveStrength` and pushes the
 *  result into `emissiveColor` (HDR — may exceed 1.0). The core PBR shader then
 *  samples the emissive texture, multiplies by this factor, and lets tonemap +
 *  exposure compress the result back into display range.
 *
 *  Registering this ext also activates the emissive-color fragment (via
 *  PBR_HAS_EMISSIVE_COLOR in mesh-features.ts → `!!mat.emissiveColor`), so
 *  scenes without the extension pay zero bytes. */
import type { GltfFeature } from "./gltf-feature.js";

const ext: GltfFeature = {
    id: "KHR_materials_emissive_strength",
    async applyMaterial(mat) {
        const e = mat._rawMatDef?.extensions?.KHR_materials_emissive_strength;
        if (!e) {
            return null;
        }
        const s = e.emissiveStrength ?? 1.0;
        const f = mat._emissiveFactor;
        return {
            emissiveColor: [f[0] * s, f[1] * s, f[2] * s],
        };
    },
};
export default ext;
