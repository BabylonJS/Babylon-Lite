import { describe, expect, it } from "vitest";

import { createRotationSectorMaterial } from "../../../packages/babylon-lite/src/gizmo/rotation-sector-material";

describe("rotation sector material", () => {
    it("keeps the drag-angle sign independent of which side of the ring is visible", () => {
        const material = createRotationSectorMaterial([1, 1, 0]);

        expect(material.fragmentSource).not.toContain("@builtin(front_facing)");
        expect(material.fragmentSource).toContain("let delta:f32=-shaderUniforms.angles.y;");
    });
});
