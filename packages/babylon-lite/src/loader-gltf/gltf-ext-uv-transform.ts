/** glTF KHR_texture_transform — collapses per-textureInfo scale/offset into a
 *  single material-wide ST quad. Lite supports only the case where every
 *  textureInfo in the material agrees on scale + offset and uses no rotation.
 *  Inconsistent or rotated transforms are silently ignored (return null). */
import type { GltfFeature } from "./gltf-feature.js";

const ext: GltfFeature = {
    id: "KHR_texture_transform",
    async applyMaterial(mat) {
        const m = mat._rawMatDef;
        if (!m) {
            return null;
        }
        const pbr = m.pbrMetallicRoughness;
        const e = m.extensions;
        const sg = e?.KHR_materials_pbrSpecularGlossiness;
        const cc = e?.KHR_materials_clearcoat;
        const sh = e?.KHR_materials_sheen;
        const texInfos: any[] = [
            sg?.diffuseTexture ?? pbr?.baseColorTexture,
            pbr?.metallicRoughnessTexture,
            m.normalTexture,
            m.occlusionTexture,
            m.emissiveTexture,
            sg?.specularGlossinessTexture,
            cc?.clearcoatTexture,
            cc?.clearcoatRoughnessTexture,
            cc?.clearcoatNormalTexture,
            sh?.sheenColorTexture,
            sh?.sheenRoughnessTexture,
        ];
        let st: [number, number, number, number] | undefined;
        for (const ti of texInfos) {
            const kt = ti?.extensions?.KHR_texture_transform;
            if (!kt || kt.rotation) {
                continue;
            }
            const s = kt.scale ?? [1, 1];
            const o = kt.offset ?? [0, 0];
            if (!st) {
                st = [s[0], s[1], o[0], o[1]];
            } else if (s[0] !== st[0] || s[1] !== st[1] || o[0] !== st[2] || o[1] !== st[3]) {
                return null;
            }
        }
        return st ? { uvTransformST: st } : null;
    },
};
export default ext;
