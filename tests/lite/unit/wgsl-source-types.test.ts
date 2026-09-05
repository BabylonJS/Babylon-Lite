import { describe, expect, it } from "vitest";
import type { ShaderMaterialOptions } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { wgsl, type WgslSource } from "../../../packages/babylon-lite/src/shader/wgsl";

describe("WgslSource", () => {
    it("requires tagged sources inside the source tree", () => {
        const tagged: WgslSource = wgsl`fn main() {}`;
        const shaderSource: ShaderMaterialOptions["vertexSource"] = tagged;

        // @ts-expect-error Source-tree shader material calls must use the wgsl tag.
        const untaggedSource: ShaderMaterialOptions["vertexSource"] = `fn main() {}`;

        expect(shaderSource).toBe(untaggedSource);
    });
});
