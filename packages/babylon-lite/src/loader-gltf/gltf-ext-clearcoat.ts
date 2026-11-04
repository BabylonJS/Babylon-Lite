/** glTF KHR_materials_clearcoat extension. */
import type { GltfFeature } from "./gltf-feature.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { setPbrClearCoat } from "../material/pbr/set-clearcoat.js";

const ext: GltfFeature = {
    id: "KHR_materials_clearcoat",
    async applyMaterial(mat, ctx) {
        const c = mat._rawMatDef?.extensions?.KHR_materials_clearcoat;
        if (!c) {
            return null;
        }
        const [tex, rough, normal] = await Promise.all([
            ctx._texture(c.clearcoatTexture, false),
            ctx._texture(c.clearcoatRoughnessTexture, false),
            ctx._texture(c.clearcoatNormalTexture, false),
        ]);
        // setPbrClearCoat both writes the prop and registers the clearcoat ext. It
        // statically imports the fragment, and this handler module is itself only
        // dynamic-imported when the asset declares KHR_materials_clearcoat, so the
        // fragment stays out of the always-loaded base chunk.
        const out: Partial<PbrMaterialProps> = {};
        setPbrClearCoat(out, {
            isEnabled: true,
            intensity: c.clearcoatFactor ?? (c.clearcoatTexture ? 1 : 0),
            roughness: c.clearcoatRoughnessFactor ?? (c.clearcoatRoughnessTexture ? 1 : 0),
            texture: tex,
            roughnessTexture: rough,
            bumpTexture: normal,
            bumpTextureScale: c.clearcoatNormalTexture?.scale ?? 1,
            useF0Remap: false,
        });
        return out;
    },
};
export default ext;
