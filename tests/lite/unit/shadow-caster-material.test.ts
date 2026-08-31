/**
 * `setShadowCasterMaterial` — the public seam that lets a material cast its shadow
 * through an alternate material (used by surfaces that receive shadows through
 * resources aliasing the shadow map, e.g. a custom CSM-sampling `ShaderMaterial`).
 */

import { describe, expect, it } from "vitest";
import { setShadowCasterMaterial } from "../../../packages/babylon-lite/src/material/set-shadow-caster-material";
import { getNoColorView } from "../../../packages/babylon-lite/src/shadow/pcf-shadow-task-hooks";
import type { Material, MaterialView } from "../../../packages/babylon-lite/src/material/material";

function fakeMaterial(name: string): Material {
    return { name } as unknown as Material;
}

describe("setShadowCasterMaterial", () => {
    it("stores the caster override on the source material", () => {
        const visible = fakeMaterial("visible");
        const caster = fakeMaterial("caster");
        setShadowCasterMaterial(visible, caster);
        expect(visible._shadowCasterMaterial).toBe(caster);
    });

    it("clears the override when passed null", () => {
        const visible = fakeMaterial("visible");
        setShadowCasterMaterial(visible, fakeMaterial("caster"));
        setShadowCasterMaterial(visible, null);
        expect(visible._shadowCasterMaterial).toBeUndefined();
    });

    it("rejects a self-reference, which would recurse in the caster-view resolver", () => {
        const visible = fakeMaterial("visible");
        expect(() => setShadowCasterMaterial(visible, visible)).toThrow("must not cycle back");
    });

    it("rejects a 2-node cycle (A casts through B, B casts through A)", () => {
        const a = fakeMaterial("a");
        const b = fakeMaterial("b");
        setShadowCasterMaterial(a, b);
        expect(() => setShadowCasterMaterial(b, a)).toThrow("must not cycle back");
        // The rejected assignment must not have been applied.
        expect(b._shadowCasterMaterial).toBeUndefined();
    });

    it("rejects a longer cycle (A -> B -> C -> A)", () => {
        const a = fakeMaterial("a");
        const b = fakeMaterial("b");
        const c = fakeMaterial("c");
        setShadowCasterMaterial(a, b);
        setShadowCasterMaterial(b, c);
        expect(() => setShadowCasterMaterial(c, a)).toThrow("must not cycle back");
        expect(c._shadowCasterMaterial).toBeUndefined();
    });

    it("allows a non-cyclic chain of casters (A -> B -> C)", () => {
        const a = fakeMaterial("a");
        const b = fakeMaterial("b");
        const c = fakeMaterial("c");
        setShadowCasterMaterial(a, b);
        setShadowCasterMaterial(b, c);
        expect(a._shadowCasterMaterial).toBe(b);
        expect(b._shadowCasterMaterial).toBe(c);
    });
});

describe("the caster-view resolver shared by the PCF and CSM paths", () => {
    it("resolves an overridden material to the override's own no-colour view", () => {
        const visible = fakeMaterial("visible");
        const caster = fakeMaterial("caster");
        setShadowCasterMaterial(visible, caster);

        // Pre-seeded so the resolver never reaches a material family factory (which needs a device):
        // what is under test is that the override is followed at all, and cached under the RECEIVE
        // material so the caster pass's lookup — keyed by `mesh.material` — hits it.
        const casterView = { label: "caster-view" } as unknown as MaterialView;
        const cache = new Map<Material, MaterialView>([[caster, casterView]]);

        expect(getNoColorView(visible, cache)).toBe(casterView);
        expect(cache.get(visible)).toBe(casterView);
    });

    it("leaves a material without an override to its own view", () => {
        const plain = fakeMaterial("plain");
        const ownView = { label: "own-view" } as unknown as MaterialView;
        const cache = new Map<Material, MaterialView>([[plain, ownView]]);
        expect(getNoColorView(plain, cache)).toBe(ownView);
    });
});
