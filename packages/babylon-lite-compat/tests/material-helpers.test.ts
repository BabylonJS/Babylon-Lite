import { describe, expect, it } from "vitest";

import { GetSupportedSimultaneousLights } from "../src/materials/material-helpers";
import type { Scene } from "../src/scene/scene";

/**
 * `GetSupportedSimultaneousLights` is a pure capability adapter: it reads the
 * engine's reported `maxUniformBuffersPerShaderStage` cap (four non-light vertex
 * uniform buffers are reserved) and clamps the requested light count to the remaining
 * budget, down to zero when no buffer is left for even one light. These GPU-free tests
 * drive it through a fake scene whose engine reports a chosen cap.
 */

function sceneWithCap(maxUniformBuffersPerShaderStage: number | undefined): Scene {
    return {
        getEngine() {
            return { getCaps: () => ({ maxUniformBuffersPerShaderStage }) };
        },
    } as unknown as Scene;
}

describe("GetSupportedSimultaneousLights", () => {
    it("clamps the requested count to the device's UBO budget (cap - 4 reserved)", () => {
        // 12 UBOs per stage - 4 reserved = 8 lights available; request of 4 fits unchanged.
        expect(GetSupportedSimultaneousLights(sceneWithCap(12), 4)).toBe(4);
        // A request above the budget is clamped down to the 8 available lights.
        expect(GetSupportedSimultaneousLights(sceneWithCap(12), 16)).toBe(8);
    });

    it("allows zero lights when the budget cannot fit even one, rather than forcing a validation failure", () => {
        // cap - 4 reserved <= 0: no uniform buffer is left for a light, so the material
        // must render unlit instead of returning a count the device would reject.
        expect(GetSupportedSimultaneousLights(sceneWithCap(4), 16)).toBe(0);
        expect(GetSupportedSimultaneousLights(sceneWithCap(0), 16)).toBe(0);
        // cap - 4 = 1: exactly one light fits.
        expect(GetSupportedSimultaneousLights(sceneWithCap(5), 16)).toBe(1);
    });

    it("leaves the requested count untouched when the engine reports no limit", () => {
        expect(GetSupportedSimultaneousLights(sceneWithCap(undefined), 16)).toBe(16);
    });
});
