/** glTF KHR_materials_unlit extension.
 *  Flags the material as unlit — the runtime PBR shader outputs the base
 *  color directly without any lighting or tonemap. */
import type { GltfFeature } from "./gltf-feature.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { setPbrUnlit } from "../material/pbr/set-unlit.js";

const ext: GltfFeature = {
    id: "KHR_materials_unlit",
    async applyMaterial(mat) {
        if (!mat._rawMatDef?.extensions?.KHR_materials_unlit) {
            return null;
        }
        // The loader's base-color uniform or fallback already applies the glTF factor.
        // setPbrUnlit writes the prop(s) and registers the unlit ext (fragment statically
        // imported by the setter). This handler is only dynamic-imported when the asset
        // declares KHR_materials_unlit, so the fragment stays out of the base chunk.
        const out: Partial<PbrMaterialProps> = {};
        setPbrUnlit(out);
        return out;
    },
};
export default ext;
