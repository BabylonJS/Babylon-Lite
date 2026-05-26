/** glTF KHR_materials_sheen extension.
 *  Only the color texture is fetched (sRGB); when the asset packs roughness in
 *  the alpha channel of the same image, the runtime sheen path samples both
 *  from `texture` directly. Distinct sheenRoughnessTexture images are not
 *  currently supported. */
import type { GltfFeature } from "./gltf-feature.js";

const ext: GltfFeature = {
    id: "KHR_materials_sheen",
    async applyMaterial(mat, ctx) {
        const s = mat._rawMatDef?.extensions?.KHR_materials_sheen;
        if (!s) {
            return null;
        }
        const tex = await ctx._texture(s.sheenColorTexture, true);
        return {
            sheen: {
                isEnabled: true,
                color: s.sheenColorFactor ?? [0, 0, 0],
                roughness: s.sheenRoughnessFactor ?? 0,
                intensity: 1,
                texture: tex,
                albedoScaling: true,
            },
        };
    },
};
export default ext;
