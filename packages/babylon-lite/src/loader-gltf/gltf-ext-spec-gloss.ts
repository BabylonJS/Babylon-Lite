/** glTF KHR_materials_pbrSpecularGlossiness extension.
 *
 *  Replaces the metallic-roughness workflow:
 *    - diffuseTexture → baseColorTexture
 *    - specularGlossinessTexture → specGlossTexture (RGB=specular, A=glossiness)
 *
 *  Returned values override the core base-material fields via Object.assign
 *  merge order in the loader.
 *
 *  Note: spec-gloss `diffuseFactor` is currently propagated via the core
 *  `GltfMaterialData.baseColorFactor` (which defaults to [1,1,1,1] for assets
 *  that omit pbrMetallicRoughness). Spec-gloss models in our test corpus all
 *  carry a diffuseTexture, so the factor path is exercised through the
 *  texture itself. Add explicit factor handling here only if a regression
 *  appears.
 */
import type { GltfFeature } from "./gltf-feature.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";

const ext: GltfFeature = {
    id: "KHR_materials_pbrSpecularGlossiness",
    async applyMaterial(mat, ctx) {
        const sg = mat._rawMatDef?.extensions?.KHR_materials_pbrSpecularGlossiness;
        if (!sg) {
            return null;
        }
        const [diffuse, specGloss] = await Promise.all([ctx._texture(sg.diffuseTexture, true), ctx._texture(sg.specularGlossinessTexture, true)]);
        const out: Partial<PbrMaterialProps> = {};
        if (diffuse) {
            out.baseColorTexture = diffuse;
        }
        if (specGloss) {
            out.specGlossTexture = specGloss;
        }
        return out;
    },
};
export default ext;
