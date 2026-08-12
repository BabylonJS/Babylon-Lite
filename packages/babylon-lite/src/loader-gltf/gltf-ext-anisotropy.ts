/** glTF KHR_materials_anisotropy extension. */
import type { GltfFeature } from "./gltf-feature.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { setPbrAnisotropy } from "../material/pbr/set-anisotropy.js";

const ext: GltfFeature = {
    id: "KHR_materials_anisotropy",
    async applyMaterial(mat, ctx) {
        const a = mat._rawMatDef?.extensions?.KHR_materials_anisotropy;
        if (!a) {
            return null;
        }
        const rot = a.anisotropyRotation ?? 0;
        // anisotropyTexture is data (RG=direction, B=strength), so it is linear (not sRGB).
        // ctx._texture applies wrapTex → KHR_texture_transform (sets _hasTx when animated).
        const texture = a.anisotropyTexture ? await ctx._texture(a.anisotropyTexture, false) : undefined;
        // setPbrAnisotropy writes the prop and registers the ext (fragment statically
        // imported by the setter). This handler is only dynamic-imported when the asset
        // declares KHR_materials_anisotropy, so the fragment stays out of the base chunk.
        const out: Partial<PbrMaterialProps> = {};
        setPbrAnisotropy(out, {
            isEnabled: true,
            intensity: a.anisotropyStrength ?? 0,
            direction: [Math.cos(rot), Math.sin(rot)],
            texture,
        });
        return out;
    },
};
export default ext;
