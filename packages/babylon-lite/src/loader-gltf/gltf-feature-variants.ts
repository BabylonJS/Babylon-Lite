/** KHR_materials_variants feature.
 *  Triggered when the root extension carries variant definitions. Per-asset
 *  hook builds variant material data shared with the material-ext driver. */

import type { AssetContainer } from "../asset-container.js";
import { collectPbrBoundTextures, type PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { acquireTexture, releaseTexture } from "../resource/gpu-pool.js";
import type { GltfFeature } from "./gltf-feature.js";
import type { MaterialVariantData } from "./material-variants.js";

function createVariantTextureSetup(data: MaterialVariantData): NonNullable<AssetContainer["_sceneSetup"]> {
    const textures = [data.originals, ...Object.values(data.variants)].flat().flatMap(({ material }) => collectPbrBoundTextures(material as PbrMaterialProps));

    return () => {
        textures.forEach(acquireTexture);
        return () => textures.forEach(releaseTexture);
    };
}

const feature: GltfFeature = {
    id: "KHR_materials_variants",
    async applyAsset(meshes, _root, ctx) {
        const variantNames: string[] | undefined = ctx._json.extensions?.KHR_materials_variants?.variants?.map((v: { name: string }) => v.name);
        if (!variantNames?.length) {
            return {};
        }
        const { loadVariantMaterials } = await import("./gltf-variants.js");
        const materialVariants = await loadVariantMaterials(
            ctx._json,
            ctx._binChunk,
            ctx._baseUrl,
            variantNames,
            meshes,
            ctx._engine,
            ctx._matExts,
            ctx._runMatExts!,
            ctx._wrapTex
        );
        return { materialVariants, _sceneSetup: createVariantTextureSetup(materialVariants) };
    },
};
export default feature;
