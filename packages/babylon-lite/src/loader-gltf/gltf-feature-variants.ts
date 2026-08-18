/** KHR_materials_variants feature.
 *  Triggered when the root extension carries variant definitions. Per-asset
 *  hook builds variant material data shared with the material-ext driver. */

import type { AssetContainer } from "../asset-container.js";
import { collectPbrBoundTextures, type PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { acquireTexture, releaseTexture } from "../resource/gpu-pool.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { GltfFeature } from "./gltf-feature.js";
import type { MaterialVariantData } from "./material-variants.js";

function createVariantTextureSetup(data: MaterialVariantData): Pick<AssetContainer, "_sceneSetup" | "_sceneCleanups"> {
    const textures = [data.originals, ...Object.values(data.variants)].flat().flatMap(({ material }) => collectPbrBoundTextures(material as PbrMaterialProps));
    const cleanups = new WeakMap<SceneContext, () => void>();

    return {
        _sceneCleanups: cleanups,
        _sceneSetup: (scene) => {
            textures.forEach(acquireTexture);
            const cleanup = () => textures.forEach(releaseTexture);
            cleanups.set(scene, cleanup);
            scene._disposables.push(cleanup);
        },
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
        return { materialVariants, ...createVariantTextureSetup(materialVariants) };
    },
};
export default feature;
