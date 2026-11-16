import { describe, expect, it } from "vitest";

import { createDirectionalLight } from "../../../packages/babylon-lite/src/light/directional-light";
import { setLightDiffuseColor } from "../../../packages/babylon-lite/src/light/set-light-diffuse-color";
import { setLightIntensity } from "../../../packages/babylon-lite/src/light/set-light-intensity";

describe("factory light versioning", () => {
    it("bumps scalar UBO state without dirtying the world matrix", () => {
        const light = createDirectionalLight([0, -1, 0]);
        const worldVersion = light.worldMatrixVersion;
        const lightVersion = light._lightVersion;

        setLightIntensity(light, 0.5);

        expect(light._lightVersion).toBe(lightVersion + 1);
        expect(light.worldMatrixVersion).toBe(worldVersion);
    });

    it("does not bump the version when the intensity is unchanged", () => {
        const light = createDirectionalLight([0, -1, 0], 0.5);
        const lightVersion = light._lightVersion;

        setLightIntensity(light, 0.5);

        expect(light._lightVersion).toBe(lightVersion);
    });

    it("updates diffuse RGB in place and bumps only when the color changes", () => {
        const light = createDirectionalLight([0, -1, 0]);
        const diffuse = light.diffuse;
        const lightVersion = light._lightVersion;

        setLightDiffuseColor(light, [0.2, 0.4, 0.6]);

        expect(light.diffuse).toBe(diffuse);
        expect(light.diffuse).toEqual([0.2, 0.4, 0.6]);
        expect(light._lightVersion).toBe(lightVersion + 1);
        setLightDiffuseColor(light, [0.2, 0.4, 0.6]);
        expect(light._lightVersion).toBe(lightVersion + 1);
        expect(() => setLightDiffuseColor(light, [Number.NaN, 0, 0])).toThrow(/finite RGB/);
    });
});
