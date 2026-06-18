/**
 * Babylon.js `KHR_materials_variants` glTF loader extension
 * (`@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_variants`).
 *
 * Babylon.js exposes the extension's static helpers to switch a loaded asset
 * between material variants at runtime. Babylon Lite decodes the same extension
 * in its glTF loader and exposes `selectVariant` / `getVariantNames` /
 * `resetVariant` keyed by the asset container. The Babylon.js helpers are keyed
 * by the asset's **root mesh** instead, so this wrapper recovers the container
 * from the `LoadedMesh` the loader returned (`result.meshes[0]`) and delegates.
 */

import { selectVariant, getVariantNames, resetVariant } from "babylon-lite";
import type { AssetContainer as LiteAssetContainer } from "babylon-lite";

/** Recover the Lite asset container a loaded-mesh handle came from. */
function containerOf(rootMesh: unknown): LiteAssetContainer | undefined {
    return (rootMesh as { _container?: LiteAssetContainer } | null)?._container;
}

/**
 * Babylon.js `KHR_materials_variants` extension helpers. Mirrors the static
 * surface ported code calls (`SelectVariant` / `GetAvailableVariants` / `Reset`)
 * over Babylon Lite's container-keyed variant API.
 */
export const KHR_materials_variants = {
    /** Switch the loaded asset to the named material variant. */
    SelectVariant(rootMesh: unknown, variantName: string): void {
        const container = containerOf(rootMesh);
        if (container) {
            selectVariant(container, variantName);
        }
    },

    /** The variant names available on the loaded asset (empty when it has none). */
    GetAvailableVariants(rootMesh: unknown): readonly string[] {
        const container = containerOf(rootMesh);
        return container ? getVariantNames(container) : [];
    },

    /** Restore the asset's default (variant-free) materials. */
    Reset(rootMesh: unknown): void {
        const container = containerOf(rootMesh);
        if (container) {
            resetVariant(container);
        }
    },
};
