/** KHR_materials_variants feature.
 *  Triggered when the root extension carries variant definitions. Per-asset
 *  hook builds variant material data shared with the material-ext driver. */

import type { GltfFeature } from "./gltf-feature.js";

const feature: GltfFeature = {
    id: "KHR_materials_variants",
    async applyAsset(meshes, _root, ctx) {
        const variantNames: string[] | undefined = ctx._json.extensions?.KHR_materials_variants?.variants?.map((v: { name: string }) => v.name);
        if (!variantNames?.length) {
            return {};
        }
        const { loadVariantMaterials } = await import("./gltf-variants.js");
        const materialVariants = await loadVariantMaterials(ctx._json, ctx._binChunk, ctx._baseUrl, variantNames, meshes, ctx._engine, ctx._matExts, ctx._wrapTex);
        return { materialVariants };
    },
};
export default feature;
