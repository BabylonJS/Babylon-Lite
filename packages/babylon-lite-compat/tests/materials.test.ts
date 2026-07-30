import { describe, expect, it } from "vitest";

import { PBRMaterial, StandardMaterial } from "../src/materials/materials";
import { Color3 } from "../src/math/color";
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
