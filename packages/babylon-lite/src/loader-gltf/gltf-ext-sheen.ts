/** glTF KHR_materials_sheen extension.
 *  Only the color texture is fetched (sRGB); when the asset packs roughness in
 *  the alpha channel of the same image, the runtime sheen path samples both
 *  from `texture` directly. Distinct sheenRoughnessTexture images are not
 *  currently supported. */
import type { GltfFeature } from "./gltf-feature.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { setPbrSheen } from "../material/pbr/set-sheen.js";

const ext: GltfFeature = {
    id: "KHR_materials_sheen",
    async applyMaterial(mat, ctx) {
        const s = mat._rawMatDef?.extensions?.KHR_materials_sheen;
        if (!s) {
            return null;
        }
        const tex = await ctx._texture(s.sheenColorTexture, true);
        // Separate sheenRoughnessTexture (roughness in .a). Only load when it is a
        // distinct texture object from sheenColorTexture; when they reference the same
        // texture, roughness is read from the color texture's .a (sheen.texture) as before.
        const roughInfo = s.sheenRoughnessTexture;
        const sameAsColor =
            roughInfo &&
            s.sheenColorTexture &&
            roughInfo.index === s.sheenColorTexture.index &&
            roughInfo.extensions?.KHR_texture_transform === s.sheenColorTexture.extensions?.KHR_texture_transform;
        const roughnessTexture = roughInfo && !sameAsColor ? await ctx._texture(roughInfo, false) : undefined;
        // setPbrSheen writes the prop and registers the sheen ext (fragment statically
        // imported by the setter). This handler is only dynamic-imported when the asset
        // declares KHR_materials_sheen, so the fragment stays out of the base chunk.
        const out: Partial<PbrMaterialProps> = {};
        setPbrSheen(out, {
            isEnabled: true,
            color: s.sheenColorFactor ?? [0, 0, 0],
            roughness: s.sheenRoughnessFactor ?? 0,
            intensity: 1,
            texture: tex,
            ...(roughnessTexture ? { roughnessTexture } : undefined),
            albedoScaling: true,
        });
        return out;
    },
};
export default ext;
