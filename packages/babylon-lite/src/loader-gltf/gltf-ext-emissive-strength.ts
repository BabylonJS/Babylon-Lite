/** glTF KHR_materials_emissive_strength extension.
 *  Multiplies the material's emissiveFactor by `emissiveStrength` and pushes the
 *  result into the emissive color (HDR — may exceed 1.0). The core PBR shader then
 *  samples the emissive texture, multiplies by this factor, and lets tonemap +
 *  exposure compress the result back into display range.
 *
 *  Routes through `setPbrEmissive`, which registers the emissive-color ext, so
 *  scenes without the extension pay zero bytes. This layer is spread over the
 *  builder's raw-factor value and therefore wins. */
import type { GltfFeature } from "./gltf-feature.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { setPbrEmissive } from "../material/pbr/set-emissive.js";

const ext: GltfFeature = {
    id: "KHR_materials_emissive_strength",
    async applyMaterial(mat) {
        const e = mat._rawMatDef?.extensions?.KHR_materials_emissive_strength;
        if (!e) {
            return null;
        }
        const s = e.emissiveStrength ?? 1.0;
        const f = mat._emissiveFactor;
        const layer: Partial<PbrMaterialProps> = {};
        setPbrEmissive(layer, [f[0] * s, f[1] * s, f[2] * s]);
        return layer;
    },
};
export default ext;
