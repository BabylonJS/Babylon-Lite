/** glTF KHR_materials_unlit extension.
 *  Flags the material as unlit — the runtime PBR shader outputs the base
 *  color directly without any lighting or tonemap. */
import type { GltfFeature } from "./gltf-feature.js";

const ext: GltfFeature = {
    id: "KHR_materials_unlit",
    async applyMaterial(mat) {
        if (!mat._rawMatDef?.extensions?.KHR_materials_unlit) {
            return null;
        }
        const f = mat._baseColorFactor;
        // When a real baseColorTexture is present, its GPU sample contributes
        // the linear texel and `unlitColor` tints by `baseColorFactor`.  When
        // there is no texture, the 1×1 fallback already bakes the factor into
        // its byte value, so leave `unlitColor` at its default [1,1,1].
        const tint: [number, number, number] | undefined = mat._baseColorImage ? [f[0], f[1], f[2]] : undefined;
        return tint ? { unlit: true, unlitColor: tint } : { unlit: true };
    },
};
export default ext;
