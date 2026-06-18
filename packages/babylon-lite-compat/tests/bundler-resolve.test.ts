import { describe, expect, it } from "vitest";

import { mapBabylonImport, resolveCompatSpecifier, COMPAT_SOURCE_FILTER } from "../src/bundler-resolve";

describe("mapBabylonImport", () => {
    it("maps @babylonjs/core bare, deep, and side-effect imports to core", () => {
        expect(mapBabylonImport("@babylonjs/core")).toBe("core");
        expect(mapBabylonImport("@babylonjs/core/Meshes/mesh")).toBe("core");
        expect(mapBabylonImport("@babylonjs/core/Engines/Extensions/engine.dynamicTexture")).toBe("core");
    });

    it("maps @babylonjs/loaders to core", () => {
        expect(mapBabylonImport("@babylonjs/loaders")).toBe("core");
        expect(mapBabylonImport("@babylonjs/loaders/glTF")).toBe("core");
    });

    it("maps @babylonjs/addons (bare and any subpath) to addons", () => {
        expect(mapBabylonImport("@babylonjs/addons")).toBe("addons");
        expect(mapBabylonImport("@babylonjs/addons/navigation")).toBe("addons");
        expect(mapBabylonImport("@babylonjs/addons/navigation/index")).toBe("addons");
    });

    it("maps @recast-navigation core/generators to recast", () => {
        expect(mapBabylonImport("@recast-navigation/core")).toBe("recast");
        expect(mapBabylonImport("@recast-navigation/generators")).toBe("recast");
    });

    it("maps @babylonjs/materials (bare and any subpath) to materials", () => {
        expect(mapBabylonImport("@babylonjs/materials")).toBe("materials");
        expect(mapBabylonImport("@babylonjs/materials/grid/gridMaterial")).toBe("materials");
        expect(mapBabylonImport("@babylonjs/materials/grid/gridMaterial.js")).toBe("materials");
    });

    it("does not remap unrelated or out-of-scope specifiers", () => {
        expect(mapBabylonImport("@babylonjs/gui")).toBeNull();
        expect(mapBabylonImport("@recast-navigation/wasm")).toBeNull();
        expect(mapBabylonImport("./local-helper")).toBeNull();
        expect(mapBabylonImport("three")).toBeNull();
        // Must not match a package whose name merely starts with @babylonjs/core…
        expect(mapBabylonImport("@babylonjs/core-extra")).toBeNull();
        // …or @babylonjs/materials / @babylonjs/addons.
        expect(mapBabylonImport("@babylonjs/materials-extra")).toBeNull();
        expect(mapBabylonImport("@babylonjs/addons-extra")).toBeNull();
    });
});

describe("resolveCompatSpecifier", () => {
    it("resolves core/loaders to the compat barrel", () => {
        expect(resolveCompatSpecifier("@babylonjs/core")).toBe("@babylonjs/lite-compat");
        expect(resolveCompatSpecifier("@babylonjs/core/Meshes/mesh")).toBe("@babylonjs/lite-compat");
        expect(resolveCompatSpecifier("@babylonjs/loaders/glTF")).toBe("@babylonjs/lite-compat");
    });

    it("resolves addons to the navigation subpath", () => {
        expect(resolveCompatSpecifier("@babylonjs/addons")).toBe("@babylonjs/lite-compat/navigation");
        expect(resolveCompatSpecifier("@babylonjs/addons/navigation")).toBe("@babylonjs/lite-compat/navigation");
    });

    it("resolves raw recast to the recast-shim subpath", () => {
        expect(resolveCompatSpecifier("@recast-navigation/core")).toBe("@babylonjs/lite-compat/recast-shim");
        expect(resolveCompatSpecifier("@recast-navigation/generators")).toBe("@babylonjs/lite-compat/recast-shim");
    });

    it("folds materials into the compat barrel", () => {
        expect(resolveCompatSpecifier("@babylonjs/materials")).toBe("@babylonjs/lite-compat");
        expect(resolveCompatSpecifier("@babylonjs/materials/grid/gridMaterial")).toBe("@babylonjs/lite-compat");
    });

    it("returns null for specifiers that are not remapped", () => {
        expect(resolveCompatSpecifier("@babylonjs/gui")).toBeNull();
        expect(resolveCompatSpecifier("three")).toBeNull();
        // The compat specifiers themselves must not be remapped (no resolution loop).
        expect(resolveCompatSpecifier("@babylonjs/lite-compat")).toBeNull();
        expect(resolveCompatSpecifier("@babylonjs/lite-compat/navigation")).toBeNull();
    });
});

describe("COMPAT_SOURCE_FILTER", () => {
    it("matches every specifier that gets remapped", () => {
        for (const source of [
            "@babylonjs/core",
            "@babylonjs/core/Meshes/mesh",
            "@babylonjs/loaders",
            "@babylonjs/addons/navigation",
            "@recast-navigation/core",
            "@babylonjs/materials/grid/gridMaterial",
        ]) {
            expect(COMPAT_SOURCE_FILTER.test(source)).toBe(true);
            expect(resolveCompatSpecifier(source)).not.toBeNull();
        }
    });

    it("does not match unrelated specifiers", () => {
        expect(COMPAT_SOURCE_FILTER.test("three")).toBe(false);
        expect(COMPAT_SOURCE_FILTER.test("./local-helper")).toBe(false);
    });
});
