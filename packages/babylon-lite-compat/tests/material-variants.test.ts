import { describe, expect, it, vi } from "vitest";
import { createPbrMaterial } from "babylon-lite";
import type { AssetContainer as LiteAssetContainer } from "babylon-lite";

import { KHR_materials_variants } from "../src/loading/material-variants";
import { collectLoadedMeshes } from "../src/loading/loaded-mesh";
import type { PBRMaterial } from "../src/materials/materials";
import type { Scene } from "../src/scene/scene";

/**
 * GPU-free coverage for the `KHR_materials_variants` wrapper. It recovers the
 * Lite asset container from the loaded root mesh (`result.meshes[0]._container`)
 * and delegates to Lite's pure container-keyed variant API, so the dispatch is
 * testable with a fake container carrying `materialVariants`.
 */
describe("KHR_materials_variants", () => {
    function fakeRoot(names: readonly string[]): unknown {
        const originals: unknown[] = [];
        const variants: Record<string, unknown[]> = {};
        for (const n of names) {
            variants[n] = [];
        }
        return { _container: { materialVariants: { names, originals, variants } } };
    }

    it("lists the available variants from the loaded root mesh", () => {
        const root = fakeRoot(["White", "Red"]);
        expect(KHR_materials_variants.GetAvailableVariants(root)).toEqual(["White", "Red"]);
    });

    it("selecting and resetting a variant does not throw", () => {
        const root = fakeRoot(["White", "Red"]);
        expect(() => KHR_materials_variants.SelectVariant(root, "White")).not.toThrow();
        expect(() => KHR_materials_variants.Reset(root)).not.toThrow();
    });

    it("is a safe no-op when the mesh has no container", () => {
        expect(KHR_materials_variants.GetAvailableVariants({})).toEqual([]);
        expect(() => KHR_materials_variants.SelectVariant(null, "White")).not.toThrow();
    });

    it("refreshes the compat facade after select and reset change the native material", () => {
        const original = createPbrMaterial({ name: "Original", metallicFactor: 0.1 });
        const variant = createPbrMaterial({ name: "Variant", metallicFactor: 0.8 });
        const mesh = { name: "Cube", children: [], _gpu: {}, material: original };
        const root = { name: "__root__", children: [mesh] };
        const container = {
            entities: [root],
            materialVariants: {
                names: ["Red"],
                originals: [{ mesh, material: original }],
                variants: { Red: [{ mesh, material: variant }] },
            },
        } as unknown as LiteAssetContainer;
        const registerMaterial = vi.fn();
        const scene = {
            _registerMesh: vi.fn(),
            _registerMaterial: registerMaterial,
            _wrapLoadedMaterial: (lite: object) => {
                const cached = wrappers.get(lite);
                if (cached) {
                    return cached;
                }
                const wrapper = {
                    name: (lite as { name?: string }).name ?? "",
                    _lite: lite,
                    get metallic() {
                        return (lite as { metallicFactor?: number }).metallicFactor ?? 1;
                    },
                    set metallic(value: number) {
                        (lite as { metallicFactor?: number }).metallicFactor = value;
                    },
                } as unknown as PBRMaterial;
                wrappers.set(lite, wrapper);
                return wrapper;
            },
        } as unknown as Scene;
        const wrappers = new Map<object, PBRMaterial>();
        const compatMeshes = collectLoadedMeshes(container, new Map(), scene);
        const compatRoot = compatMeshes[0]!;
        const compatMesh = compatMeshes[1]!;

        expect(compatMesh.material?.name).toBe("Original");
        KHR_materials_variants.SelectVariant(compatRoot, "Red");
        expect(compatMesh.material?.name).toBe("Variant");
        (compatMesh.material as PBRMaterial).metallic = 0.25;
        expect(variant.metallicFactor).toBe(0.25);

        KHR_materials_variants.Reset(compatRoot);
        expect(compatMesh.material?.name).toBe("Original");
        expect(compatMesh.material?._lite).toBe(original);
    });
});
