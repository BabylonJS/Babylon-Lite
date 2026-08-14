import { describe, expect, it } from "vitest";

import { GetSupportedSimultaneousLights } from "../src/materials/material-helpers";
import type { Scene } from "../src/scene/scene";

/**
 * `GetSupportedSimultaneousLights` is a pure capability adapter: it reads the
 * engine's reported `maxUniformBuffersPerShaderStage` cap (four non-light vertex
 * uniform buffers are reserved) and clamps the requested light count to it, never
 * dropping below one light. These GPU-free tests drive it through a fake scene whose
 * engine reports a chosen cap.
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

    it("keeps at least one light even with an unusually low limit", () => {
        expect(GetSupportedSimultaneousLights(sceneWithCap(4), 16)).toBe(1);
        expect(GetSupportedSimultaneousLights(sceneWithCap(0), 16)).toBe(1);
    });

    it("leaves the requested count untouched when the engine reports no limit", () => {
        expect(GetSupportedSimultaneousLights(sceneWithCap(undefined), 16)).toBe(16);
    });
});
