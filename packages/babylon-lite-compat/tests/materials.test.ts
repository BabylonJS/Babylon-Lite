import { describe, expect, it, vi } from "vitest";

import { Material, PBRMaterial, StandardMaterial } from "../src/materials/materials";
import type { Scene } from "../src/scene/scene";
import type { BaseTexture } from "../src/textures/textures";

/** Minimal stand-in for a resolved compat texture (only `_lite` is read by the setters). */
function fakeTexture(): BaseTexture {
    return { _lite: { id: "tex" } } as unknown as BaseTexture;
}

/** Minimal fake compat scene that satisfies the `Material` constructor's registration hook. */
function fakeScene(): Scene {
    return { _registerMaterial: vi.fn(), _unregisterMaterial: vi.fn() } as unknown as Scene;
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

    it("the same texture can back both diffuse and emissive slots (basis scene 36)", () => {
        const mat = new StandardMaterial("dog");
        const tex = fakeTexture();
        mat.diffuseTexture = tex;
        mat.emissiveTexture = tex;
        expect(mat._lite.diffuseTexture).toBe(tex._lite);
        expect(mat._lite.emissiveTexture).toBe(tex._lite);
    });
});

describe("Material.getScene", () => {
    it("returns the scene the material was constructed against", () => {
        const scene = fakeScene();
        const mat = new StandardMaterial("dog", scene);
        expect(mat.getScene()).toBe(scene);
        expect((mat as Material) instanceof Material).toBe(true);
    });

    it("returns undefined for a scene-less material", () => {
        const mat = new StandardMaterial("dog");
        expect(mat.getScene()).toBeUndefined();
    });
});

describe("Material.getActiveTextures", () => {
    it("returns an empty array when no textures are bound", () => {
        expect(new StandardMaterial("dog").getActiveTextures()).toEqual([]);
        expect(new PBRMaterial("cat").getActiveTextures()).toEqual([]);
    });

    it("enumerates every bound standard-material slot without duplicates removed", () => {
        const mat = new StandardMaterial("dog");
        const diffuse = fakeTexture();
        const bump = fakeTexture();
        const emissive = fakeTexture();
        mat.diffuseTexture = diffuse;
        mat.bumpTexture = bump;
        mat.emissiveTexture = emissive;
        expect(mat.getActiveTextures()).toEqual([diffuse, bump, emissive]);

        mat.bumpTexture = null;
        expect(mat.getActiveTextures()).toEqual([diffuse, emissive]);
    });

    it("enumerates PBR base and extension (sheen) texture slots", () => {
        const mat = new PBRMaterial("cat");
        const albedo = fakeTexture();
        const sheenTex = fakeTexture();
        mat.albedoTexture = albedo;
        mat.sheen.texture = sheenTex;
        expect(mat.sheen.texture).toBe(sheenTex);
        expect(mat._lite.sheen?.texture).toBe(sheenTex._lite);
        expect(mat.getActiveTextures()).toEqual([albedo, sheenTex]);

        mat.sheen.texture = null;
        expect(mat._lite.sheen?.texture).toBeUndefined();
        expect(mat.getActiveTextures()).toEqual([albedo]);
    });

    it("enumerates the PBR reflection texture", () => {
        const scene = fakeScene();
        const mat = new PBRMaterial("cat", scene);
        const reflection = fakeTexture();
        mat.reflectionTexture = reflection as never;
        expect(mat.getActiveTextures()).toEqual([reflection]);
    });

    it("enumerates the scene environment texture when the PBR material has no override", () => {
        const reflection = fakeTexture();
        const scene = { ...fakeScene(), environmentTexture: reflection } as unknown as Scene;
        const mat = new PBRMaterial("cat", scene);
        expect(mat.getActiveTextures()).toEqual([reflection]);
    });
});
