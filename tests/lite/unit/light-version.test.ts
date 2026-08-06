import { describe, expect, it } from "vitest";

import { createDirectionalLight } from "../../../packages/babylon-lite/src/light/directional-light";

describe("factory light versioning", () => {
    it("bumps scalar UBO state without dirtying the world matrix", () => {
        const light = createDirectionalLight([0, -1, 0]);
        const worldVersion = light.worldMatrixVersion;
        const lightVersion = light._lightVersion;

        light.intensity = 0.5;
        light._bumpLightVersion?.();

        expect(light._lightVersion).toBe(lightVersion + 1);
        expect(light.worldMatrixVersion).toBe(worldVersion);
    });
});
