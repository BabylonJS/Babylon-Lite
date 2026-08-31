import { beforeEach, describe, expect, it, vi } from "vitest";

const { createCsmDirectionalShadowGenerator, setShadowTaskCasterMeshes } = vi.hoisted(() => ({
    createCsmDirectionalShadowGenerator: vi.fn(() => ({ kind: "csm" })),
    setShadowTaskCasterMeshes: vi.fn(),
}));

vi.mock("babylon-lite", async (importOriginal) => ({
    ...(await importOriginal<typeof import("babylon-lite")>()),
    createCsmDirectionalShadowGenerator,
    setShadowTaskCasterMeshes,
}));

import type { EngineContext } from "babylon-lite";

import { DirectionalLight } from "../src/lights/lights";
import { Vector3 } from "../src/math/vector";
import { CascadedShadowGenerator } from "../src/shadows/shadow-generator";

describe("CascadedShadowGenerator", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("forwards Babylon.js CSM settings to the native Lite generator", () => {
        const light = new DirectionalLight("directional", new Vector3(0, -1, -1));
        const generator = new CascadedShadowGenerator(2048, light);
        generator.numCascades = 3;
        generator.lambda = 0.7;
        generator.cascadeBlendPercentage = 0.2;
        generator.stabilizeCascades = true;
        generator.shadowMaxZ = 500;
        generator.bias = 0.001;
        generator.darkness = 0.25;
        generator.frustumEdgeFalloff = 0.15;

        generator._build({} as EngineContext);

        expect(createCsmDirectionalShadowGenerator).toHaveBeenCalledWith({}, light._lite, {
            mapSize: 2048,
            numCascades: 3,
            lambda: 0.7,
            cascadeBlendPercentage: 0.2,
            stabilizeCascades: true,
            shadowMaxZ: 500,
            bias: 0.001,
            darkness: 0.25,
            frustumEdgeFalloff: 0.15,
        });
        expect(light._lite.shadowGenerator).toEqual({ kind: "csm" });
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith({ kind: "csm" }, []);
    });

    it("clamps the cascade count to the Babylon.js range", () => {
        const generator = new CascadedShadowGenerator(2048, new DirectionalLight("directional", new Vector3(0, -1, -1)));

        generator.numCascades = 0;
        expect(generator.numCascades).toBe(2);
        generator.numCascades = 1;
        expect(generator.numCascades).toBe(2);
        generator.numCascades = 4;
        expect(generator.numCascades).toBe(4);
        generator.numCascades = 5;
        expect(generator.numCascades).toBe(4);
    });
});
