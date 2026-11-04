import { describe, expect, it } from "vitest";
import {
    isScene348CameraPose,
    readScene348Settings,
    SCENE348_CAMERAS,
    SCENE348_ASSETS,
    SCENE348_PANEL_SIZE,
    SCENE348_PANELS,
    scene348Query,
} from "../../../lab/lite/src/shared/scene348-parallax.js";

describe("scene 348 comparison inputs", () => {
    it("uses identical default settings and round-trips shared URLs", () => {
        const defaults = readScene348Settings("");
        expect(defaults).toEqual({ pom: true, depth: 0.06, view: "grazing", asset: "stone", quality: "medium", embed: false });
        expect(readScene348Settings(scene348Query(defaults))).toEqual(defaults);
        expect(readScene348Settings(scene348Query(defaults, true)).embed).toBe(true);
        expect(SCENE348_PANEL_SIZE * defaults.depth).toBeCloseTo(0.144);
    });

    it("keeps explicitly selected front and oblique views available", () => {
        expect(readScene348Settings("?view=front").view).toBe("front");
        expect(readScene348Settings("?view=oblique").view).toBe("oblique");
    });

    it.each(["?pom=maybe", "?view=unknown", "?asset=unknown", "?quality=unknown", "?depth=NaN", "?depth=-0.1", "?depth=0.17"])("rejects invalid scene settings %s", (query) => {
        expect(() => readScene348Settings(query)).toThrow();
    });

    it("keeps the normal-only controls in the left column for both families", () => {
        expect(SCENE348_PANELS.filter((panel) => !panel.pom).map((panel) => panel.family)).toEqual(["standard", "pbr"]);
        expect(SCENE348_PANELS.every((panel) => (panel.pom ? panel.x > 0 : panel.x < 0))).toBe(true);
    });

    it("uses the exact original Playground diffuse and normal-height pairs", () => {
        expect(SCENE348_ASSETS).toEqual({
            stone: { color: "https://i.imgur.com/VSbN3Fc.png", normalHeight: "https://i.imgur.com/zVGaZNi.png" },
            wall: { color: "https://i.imgur.com/Rkh1uFK.png", normalHeight: "https://i.imgur.com/GtIUsWW.png" },
        });
    });

    it("round-trips the wall selection and drops obsolete procedural-normal settings", () => {
        const settings = readScene348Settings("?asset=wall&normals=bevel");
        expect(settings.asset).toBe("wall");
        expect(readScene348Settings(scene348Query(settings))).toEqual(settings);
        expect(scene348Query(settings)).not.toContain("normals=");
    });

    it("accepts the camera presets and rejects non-finite or out-of-range frame messages", () => {
        for (const pose of Object.values(SCENE348_CAMERAS)) {
            expect(isScene348CameraPose(pose)).toBe(true);
        }
        for (const pose of [null, {}, { ...SCENE348_CAMERAS.oblique, alpha: Infinity }, { ...SCENE348_CAMERAS.oblique, radius: 0 }, { ...SCENE348_CAMERAS.oblique, beta: -1 }]) {
            expect(isScene348CameraPose(pose)).toBe(false);
        }
    });
});
