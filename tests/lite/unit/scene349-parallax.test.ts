import { describe, expect, it } from "vitest";
import {
    isScene349CameraPose,
    readScene349Settings,
    SCENE349_CAMERAS,
    SCENE349_ASSETS,
    SCENE349_PANEL_SIZE,
    SCENE349_PANELS,
    scene349Query,
} from "../../../lab/lite/src/shared/scene349-parallax.js";

describe("scene 349 comparison inputs", () => {
    it("uses identical default settings and round-trips shared URLs", () => {
        const defaults = readScene349Settings("");
        expect(defaults).toEqual({ pom: true, depth: 0.06, view: "grazing", asset: "stone", quality: "medium", embed: false });
        expect(readScene349Settings(scene349Query(defaults))).toEqual(defaults);
        expect(readScene349Settings(scene349Query(defaults, true)).embed).toBe(true);
        expect(SCENE349_PANEL_SIZE * defaults.depth).toBeCloseTo(0.144);
    });

    it("keeps explicitly selected front and oblique views available", () => {
        expect(readScene349Settings("?view=front").view).toBe("front");
        expect(readScene349Settings("?view=oblique").view).toBe("oblique");
    });

    it.each(["?pom=maybe", "?view=unknown", "?asset=unknown", "?quality=unknown", "?depth=NaN", "?depth=-0.1", "?depth=0.17"])("rejects invalid scene settings %s", (query) => {
        expect(() => readScene349Settings(query)).toThrow();
    });

    it("keeps the normal-only controls in the left column for both families", () => {
        expect(SCENE349_PANELS.filter((panel) => !panel.pom).map((panel) => panel.family)).toEqual(["standard", "pbr"]);
        expect(SCENE349_PANELS.every((panel) => (panel.pom ? panel.x > 0 : panel.x < 0))).toBe(true);
    });

    it("uses the exact original Playground diffuse and normal-height pairs", () => {
        expect(SCENE349_ASSETS).toEqual({
            stone: { color: "https://i.imgur.com/VSbN3Fc.png", normalHeight: "https://i.imgur.com/zVGaZNi.png" },
            wall: { color: "https://i.imgur.com/Rkh1uFK.png", normalHeight: "https://i.imgur.com/GtIUsWW.png" },
        });
    });

    it("round-trips the wall selection and drops obsolete procedural-normal settings", () => {
        const settings = readScene349Settings("?asset=wall&normals=bevel");
        expect(settings.asset).toBe("wall");
        expect(readScene349Settings(scene349Query(settings))).toEqual(settings);
        expect(scene349Query(settings)).not.toContain("normals=");
    });

    it("accepts the camera presets and rejects non-finite or out-of-range frame messages", () => {
        for (const pose of Object.values(SCENE349_CAMERAS)) {
            expect(isScene349CameraPose(pose)).toBe(true);
        }
        for (const pose of [null, {}, { ...SCENE349_CAMERAS.oblique, alpha: Infinity }, { ...SCENE349_CAMERAS.oblique, radius: 0 }, { ...SCENE349_CAMERAS.oblique, beta: -1 }]) {
            expect(isScene349CameraPose(pose)).toBe(false);
        }
    });
});
