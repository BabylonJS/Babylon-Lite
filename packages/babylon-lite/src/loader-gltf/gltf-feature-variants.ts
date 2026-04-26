/** KHR_materials_variants feature.
 *  Triggered when the root extension carries variant definitions. Per-asset
 *  hook builds variant material data shared with the material-ext driver. */

import type { GltfFeature } from "./gltf-feature.js";

const feature: GltfFeature = {
    id: "KHR_materials_variants",
    async applyAsset(meshes, _root, ctx) {
        const variantNames: string[] | undefined = ctx.json.extensions?.KHR_materials_variants?.variants?.map((v: { name: string }) => v.name);
        if (!variantNames?.length) {
            return {};
        }
        const { loadVariantMaterials } = await import("./gltf-variants.js");
        const materialVariants = await loadVariantMaterials(ctx.json, ctx.binChunk, ctx.baseUrl, variantNames, meshes, ctx.engine, ctx.matExts, ctx.wrapTex);
        return { materialVariants };
    },
};
export default feature;
