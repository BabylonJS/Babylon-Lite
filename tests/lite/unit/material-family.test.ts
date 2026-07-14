import { describe, expect, it } from "vitest";

import { getMaterialFamily } from "../../../packages/babylon-lite/src/material/material-family";
import { createMaterialView } from "../../../packages/babylon-lite/src/material/material-view";
import { isPbrMaterial, isStandardMaterial, isShaderMaterial, isNodeMaterial } from "../../../packages/babylon-lite/src/material/material-guards";
import type { Material } from "../../../packages/babylon-lite/src/material/material";

/** Device-free material stub: getMaterialFamily only reads `_buildGroup._materialFamily`
 *  (unwrapping a view to its source first). */
function fakeMaterial(family?: string): Material {
    return {
        _buildGroup: { _materialFamily: family } as unknown as Material["_buildGroup"],
        _uboVersion: 0,
    } as Material;
}

describe("getMaterialFamily", () => {
    it("returns the core family strings", () => {
        expect(getMaterialFamily(fakeMaterial("pbr"))).toBe("pbr");
        expect(getMaterialFamily(fakeMaterial("standard"))).toBe("standard");
        expect(getMaterialFamily(fakeMaterial("shader"))).toBe("shader");
        expect(getMaterialFamily(fakeMaterial("node"))).toBe("node");
    });

    it("returns undefined when a material declares no family", () => {
        expect(getMaterialFamily(fakeMaterial(undefined))).toBeUndefined();
    });

    it("returns undefined (no throw) for a plain material-like object with no builder", () => {
        // _buildGroup is @internal / trimmed from the public d.ts, so callers can legally
        // pass a bare { name, metadata } typed as Material.
        expect(getMaterialFamily({ name: "plain" } as unknown as Material)).toBeUndefined();
    });

    it("reports a custom builder's own family string", () => {
        expect(getMaterialFamily(fakeMaterial("myCustomType"))).toBe("myCustomType");
    });

    it("reports the source family through a material view", () => {
        const source = fakeMaterial("pbr");
        const view = createMaterialView(source, { features: 0 });
        expect(getMaterialFamily(view)).toBe("pbr");
    });
});

describe("material type guards", () => {
    it("each guard matches only its own family", () => {
        const pbr = fakeMaterial("pbr");
        const standard = fakeMaterial("standard");
        const shader = fakeMaterial("shader");
        const node = fakeMaterial("node");

        expect(isPbrMaterial(pbr)).toBe(true);
        expect(isPbrMaterial(standard)).toBe(false);

        expect(isStandardMaterial(standard)).toBe(true);
        expect(isStandardMaterial(pbr)).toBe(false);

        expect(isShaderMaterial(shader)).toBe(true);
        expect(isShaderMaterial(node)).toBe(false);

        expect(isNodeMaterial(node)).toBe(true);
        expect(isNodeMaterial(shader)).toBe(false);
    });

    it("returns false for a family-less material", () => {
        const unknown = fakeMaterial(undefined);
        expect(isPbrMaterial(unknown)).toBe(false);
        expect(isStandardMaterial(unknown)).toBe(false);
        expect(isShaderMaterial(unknown)).toBe(false);
        expect(isNodeMaterial(unknown)).toBe(false);
    });

    it("matches through a material view over a typed source", () => {
        const view = createMaterialView(fakeMaterial("pbr"), { features: 0 });
        expect(isPbrMaterial(view)).toBe(true);
        expect(isStandardMaterial(view)).toBe(false);
    });
});
