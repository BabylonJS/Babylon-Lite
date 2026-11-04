import { describe, expect, it } from "vitest";

import { KHR_materials_variants } from "../src/loading/material-variants";

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
});
