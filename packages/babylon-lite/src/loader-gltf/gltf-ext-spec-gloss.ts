/** glTF KHR_materials_pbrSpecularGlossiness extension.
 *
 *  Replaces the metallic-roughness workflow:
 *    - diffuseTexture → baseColorTexture
 *    - specularGlossinessTexture → specGlossTexture (RGB=specular, A=glossiness)
 *
 *  Returned values override the core base-material fields via Object.assign
 *  merge order in the loader.
 *
 *  Factors multiply decoded linear texels, with identity texels when absent.
 *  The core MR fallback must not contribute to the supported SG workflow.
 */
import type { GltfFeature } from "./gltf-feature.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { _registerPbrExt } from "../material/pbr/pbr-flags.js";
import { pbrExt } from "../material/pbr/fragments/spec-gloss-fragment.js";
import { cloneTexture2D } from "../texture/texture-2d.js";
import type { Texture2D } from "../texture/texture-2d.js";

// With no KHR_texture_transform feature, the loader's wrapper is an identity.
// Keep the extension texture's own TEXCOORD selection in that case too.
function textureCoord(texture: Texture2D, info: { texCoord?: number; extensions?: { KHR_texture_transform?: { texCoord?: number } } }): Texture2D {
    const coord = info.extensions?.KHR_texture_transform?.texCoord ?? info.texCoord;
    return coord === 1 && (texture as { _texCoord?: number })._texCoord !== 1 ? cloneTexture2D(texture, { _texCoord: 1 }) : texture;
}

const ext: GltfFeature = {
    id: "KHR_materials_pbrSpecularGlossiness",
    async preParse(json) {
        // SG replaces core diffuse. Remove its fallback reference before generic
        // texture-source hooks or image decoding, including for variant materials.
        for (const mat of json.materials ?? []) {
            if (mat.extensions?.KHR_materials_pbrSpecularGlossiness && mat.pbrMetallicRoughness) {
                delete mat.pbrMetallicRoughness.baseColorTexture;
            }
        }
    },
    async applyMaterial(mat, ctx) {
        const sg = mat._rawMatDef?.extensions?.KHR_materials_pbrSpecularGlossiness;
        if (!sg) {
            return null;
        }
        const [diffuse, specGloss] = await Promise.all([ctx._texture(sg.diffuseTexture, true), ctx._texture(sg.specularGlossinessTexture, true)]);
        const sf = sg.specularFactor;
        _registerPbrExt(pbrExt);
        // Default texture assembly follows this hook. An omitted SG diffuse texture
        // must use white, never a baked MR fallback factor/image. Keep exact SG factors
        // in floating-point uniforms, including for factor-only materials.
        mat._baseColorFactor = [1, 1, 1, 1];
        mat._baseColorImage = null;
        const out: Partial<PbrMaterialProps> = {
            baseColorFactor: sg.diffuseFactor ?? [1, 1, 1, 1],
            _specularGlossiness: [sf?.[0] ?? 1, sf?.[1] ?? 1, sf?.[2] ?? 1, sg.glossinessFactor ?? 1],
            alpha: 1,
        };
        if (diffuse) {
            out.baseColorTexture = textureCoord(diffuse, sg.diffuseTexture);
        }
        if (specGloss) {
            out.specGlossTexture = textureCoord(specGloss, sg.specularGlossinessTexture);
        }
        if ((diffuse as { _hasTx?: boolean } | undefined)?._hasTx || (specGloss as { _hasTx?: boolean } | undefined)?._hasTx) {
            const { enableMaterialUvTransform } = await import("../material/pbr/enable-material-uv-transform.js");
            enableMaterialUvTransform(out);
        }
        return out;
    },
};
export default ext;
