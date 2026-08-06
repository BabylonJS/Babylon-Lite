import { describe, expect, it } from "vitest";

import { enableMaterialUvTransform, type PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";

describe("PBR UV transform detection", () => {
    it("opts a hand-built material into UV transforms before build", () => {
        const material = {} as PbrMaterialProps;
        expect(enableMaterialUvTransform(material)).toBe(true);
        expect(material._hasUvTx).toBe(true);

        (material as PbrMaterialProps & { _renderFeatures: { features: number } })._renderFeatures = { features: 0 };
        expect(enableMaterialUvTransform(material)).toBe(false);
    });
});
