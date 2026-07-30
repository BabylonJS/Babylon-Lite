import { describe, expect, it, vi } from "vitest";
import * as lite from "babylon-lite";

import { StandardMaterial, PBRMaterial, PBRMetallicRoughnessMaterial, PBRSpecularGlossinessMaterial } from "../src/materials/materials";
import { NodeMaterial } from "../src/materials/node-material";
import { Color3 } from "../src/math/color";
import type { Scene } from "../src/scene/scene";
import type { BaseTexture } from "../src/textures/textures";

/** Minimal stand-in for a resolved compat texture (only `_lite` is read by the setters). */
function fakeTexture(): BaseTexture {
    return { _lite: { id: "tex" } } as unknown as BaseTexture;
}

describe("StandardMaterial texture proxies", () => {
    it("wires emissiveTexture onto the Lite material", () => {
        const mat = new StandardMaterial("dog");
        expect(mat.emissiveTexture).toBeNull();
        expect(mat._lite.emissiveTexture).toBeNull();

        const tex = fakeTexture();
        mat.emissiveTexture = tex;
        expect(mat.emissiveTexture).toBe(tex);
        expect(mat._lite.emissiveTexture).toBe(tex._lite);

        mat.emissiveTexture = null;
        expect(mat.emissiveTexture).toBeNull();
        expect(mat._lite.emissiveTexture).toBeNull();
    });

    describe("PBRMaterial late texture binding", () => {
        it("restores the logical albedo tint when a pending texture resolves", () => {
            const mat = new PBRMaterial("dog");
            mat.albedoColor = new Color3(0.2, 0.4, 0.6);
            mat._lite.baseColorTexture = { id: "fallback" } as never;
            mat._lite.ormTexture = { id: "orm" } as never;
            mat._lite.baseColorFactor = [1, 1, 1, 1];
            const tex = fakeTexture();

            mat.albedoTexture = tex;
            mat._ensureRenderable({} as never);

            expect(mat._lite.baseColorTexture).toBe(tex._lite);
            expect(mat._lite.baseColorFactor).toEqual([0.2, 0.4, 0.6, 1]);
        });
    });

    it("the same texture can back both diffuse and emissive slots (basis scene 36)", () => {
        const mat = new StandardMaterial("dog");
        const tex = fakeTexture();
        mat.diffuseTexture = tex;
        mat.emissiveTexture = tex;
        expect(mat._lite.diffuseTexture).toBe(tex._lite);
        expect(mat._lite.emissiveTexture).toBe(tex._lite);
    });
});

describe("Material.clone", () => {
    it("StandardMaterial.clone copies data, shares textures, and gets its own renderable", () => {
        const mat = new StandardMaterial("src");
        mat.diffuseColor = new Color3(0.1, 0.2, 0.3);
        mat.alpha = 0.5;
        mat.alphaCutOff = 0.25;
        mat.disableLighting = true;
        mat.backFaceCulling = false;
        mat.transparencyMode = 2;
        mat.useAlphaFromDiffuseTexture = true;
        const tex = fakeTexture();
        mat.diffuseTexture = tex;

        const clone = mat.clone("clone");

        expect(clone).toBeInstanceOf(StandardMaterial);
        expect(clone).not.toBe(mat);
        expect(clone.name).toBe("clone");
        // Own Lite renderable (distinct props object → distinct UBO/build state).
        expect(clone._lite).not.toBe(mat._lite);
        // Data copied.
        expect(clone.diffuseColor.r).toBeCloseTo(0.1);
        expect(clone.alpha).toBe(0.5);
        expect(clone.alphaCutOff).toBe(0.25);
        expect(clone.disableLighting).toBe(true);
        expect(clone.backFaceCulling).toBe(false);
        expect(clone.transparencyMode).toBe(2);
        expect(clone.useAlphaFromDiffuseTexture).toBe(true);
        // Texture shared by reference.
        expect(clone.diffuseTexture).toBe(tex);
        expect(clone._lite.diffuseTexture).toBe(tex._lite);
        // Colour arrays are independent (mutating the clone must not alias the source).
        clone.diffuseColor = new Color3(0.9, 0.9, 0.9);
        expect(mat.diffuseColor.r).toBeCloseTo(0.1);
    });

    it("PBRMaterial.clone copies scalars and gives independent sub-configurations", () => {
        const mat = new PBRMaterial("src");
        mat.metallic = 0.25;
        mat.roughness = 0.75;
        mat.albedoColor = new Color3(0.2, 0.4, 0.6);
        mat.clearCoat.isEnabled = true;
        mat.clearCoat.intensity = 0.4;

        const clone = mat.clone("clone");

        expect(clone).toBeInstanceOf(PBRMaterial);
        expect(clone._lite).not.toBe(mat._lite);
        expect(clone.metallic).toBe(0.25);
        expect(clone.roughness).toBe(0.75);
        expect(clone.albedoColor.g).toBeCloseTo(0.4);
        expect(clone.clearCoat.isEnabled).toBe(true);
        expect(clone.clearCoat.intensity).toBeCloseTo(0.4);
        // Sub-config object is copied, not shared.
        expect(clone._lite.clearCoat).not.toBe(mat._lite.clearCoat);
        clone.clearCoat.intensity = 0.9;
        expect(mat.clearCoat.intensity).toBeCloseTo(0.4);
    });

    it("PBRMetallicRoughnessMaterial.clone returns the correct subclass", () => {
        const mat = new PBRMetallicRoughnessMaterial("src");
        mat.baseColor = new Color3(1, 0, 0);
        const clone = mat.clone("clone");
        expect(clone).toBeInstanceOf(PBRMetallicRoughnessMaterial);
        expect(clone.getClassName()).toBe("PBRMetallicRoughnessMaterial");
        expect(clone.baseColor.r).toBeCloseTo(1);
    });

    it("PBRSpecularGlossinessMaterial.clone returns the correct subclass", () => {
        const mat = new PBRSpecularGlossinessMaterial("src");
        mat.glossiness = 0.8;
        const clone = mat.clone("clone");
        expect(clone).toBeInstanceOf(PBRSpecularGlossinessMaterial);
        expect(clone.getClassName()).toBe("PBRSpecularGlossinessMaterial");
        expect(clone.glossiness).toBeCloseTo(0.8);
    });

    it("NodeMaterial.clone reuses the source graph + overrides and registers the clone", () => {
        const register = vi.fn();
        const scene = { _registerNodeMaterial: register } as unknown as Scene;
        const mat = new NodeMaterial("src", scene, { foo: "bar" });
        mat.backFaceCulling = false;
        const tex = fakeTexture();
        mat.getBlockByName("albedo").texture = tex as never;

        const clone = mat.clone("clone");

        expect(clone).toBeInstanceOf(NodeMaterial);
        expect(clone).not.toBe(mat);
        expect(clone.name).toBe("clone");
        expect(clone.backFaceCulling).toBe(false);
        expect(register).toHaveBeenCalledWith(clone);
        // Texture override shared by reference.
        expect(clone.getBlockByName("albedo").texture).toBe(tex);
    });

    it("NodeMaterial.clone remains assignable after startup and rebinds its own parsed material", async () => {
        const sourceLite = { id: "source" };
        const cloneLite = { id: "clone" };
        vi.spyOn(lite, "parseNodeMaterialFromSnippet").mockResolvedValueOnce(cloneLite as never);
        let parsePromise: Promise<void> | undefined;
        const scene = {
            _registerNodeMaterial: (material: NodeMaterial) => {
                parsePromise = material._parse({} as never);
            },
        } as unknown as Scene;
        const mat = new NodeMaterial("src", scene, { foo: "bar" });
        mat._lite = sourceLite as never;

        const clone = mat.clone("clone");
        const mesh: { material?: unknown } = {};
        clone._bindMesh(mesh as never, () => true);
        expect(mesh.material).toBe(sourceLite);

        await parsePromise!;
        expect(clone._lite).toBe(cloneLite);
        expect(mesh.material).toBe(cloneLite);
    });

    it("NodeMaterial parse does not overwrite a mesh reassigned before compilation finishes", async () => {
        const sourceLite = { id: "source" };
        const cloneLite = { id: "clone" };
        const replacementLite = { id: "replacement" };
        vi.spyOn(lite, "parseNodeMaterialFromSnippet").mockResolvedValueOnce(cloneLite as never);
        let parsePromise: Promise<void> | undefined;
        const scene = {
            _registerNodeMaterial: (material: NodeMaterial) => {
                parsePromise = material._parse({} as never);
            },
        } as unknown as Scene;
        const source = new NodeMaterial("src", scene, { foo: "bar" });
        source._lite = sourceLite as never;
        const clone = source.clone("clone");
        const mesh: { material?: unknown } = {};
        let currentMaterial: NodeMaterial | null = clone;

        clone._bindMesh(mesh as never, () => currentMaterial === clone);
        currentMaterial = null;
        mesh.material = replacementLite;

        await parsePromise!;
        expect(mesh.material).toBe(replacementLite);
    });
});
