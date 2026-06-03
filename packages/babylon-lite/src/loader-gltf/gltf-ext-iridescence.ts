/** glTF KHR_materials_iridescence extension. */
import type { GltfFeature } from "./gltf-feature.js";

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
        return {
            iridescence: {
                isEnabled: true,
                intensity: iri.iridescenceFactor ?? 0,
                indexOfRefraction: iri.iridescenceIor ?? 1.3,
                minimumThickness: iri.iridescenceThicknessMinimum ?? 100,
                maximumThickness: iri.iridescenceThicknessMaximum ?? 400,
                texture: tex,
                thicknessTexture: thicknessTex,
            },
        } as Partial<import("../material/pbr/pbr-material.js").PbrMaterialProps>;
    },
};
export default ext;
