/** glTF KHR_materials_iridescence extension. */
import type { GltfFeature } from "./gltf-feature.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { setPbrIridescence } from "../material/pbr/set-iridescence.js";

const ext: GltfFeature = {
    id: "KHR_materials_iridescence",
    async applyMaterial(mat, ctx) {
        const iri = mat._rawMatDef?.extensions?.KHR_materials_iridescence;
        if (!iri) {
            return null;
        }
        // Babylon.js' KHR_materials_iridescence loader samples these extension textures through the gamma-space path.
        // Use sRGB uploads for parity, even though the glTF channels are scalar data.
        const [tex, thicknessTex] = await Promise.all([ctx._texture(iri.iridescenceTexture, true), ctx._texture(iri.iridescenceThicknessTexture, true)]);
        // setPbrIridescence writes the prop and registers the ext (fragment statically
        // imported by the setter). This handler is only dynamic-imported when the asset
        // declares KHR_materials_iridescence, so the fragment stays out of the base chunk.
        const out: Partial<PbrMaterialProps> = {};
        setPbrIridescence(out, {
            isEnabled: true,
            intensity: iri.iridescenceFactor ?? 0,
            indexOfRefraction: iri.iridescenceIor ?? 1.3,
            minimumThickness: iri.iridescenceThicknessMinimum ?? 100,
            maximumThickness: iri.iridescenceThicknessMaximum ?? 400,
            texture: tex,
            thicknessTexture: thicknessTex,
        });
        return out;
    },
};
export default ext;
