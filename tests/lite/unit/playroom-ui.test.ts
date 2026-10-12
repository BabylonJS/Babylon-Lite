import { describe, expect, it } from "vitest";
import { calculatePlayroomUiLayout, PLAYROOM_STARTUP_INTERVAL_MS, playroomStartupRotationAtTick, playroomUiVisibility } from "../../../lab/lite/src/demos/playroom/ui.js";

describe("The Playroom source UI rules", () => {
    it("uses the source interval and observable radian rotation formulas", () => {
        expect(PLAYROOM_STARTUP_INTERVAL_MS).toBe(10);
        expect(playroomStartupRotationAtTick("loading", 0)).toBe(0);
        expect(playroomStartupRotationAtTick("loading", 1)).toBe(45);
        expect(playroomStartupRotationAtTick("loading", 8)).toBe(360);
        expect(playroomStartupRotationAtTick("ready", 0)).toBe(0);
        expect(playroomStartupRotationAtTick("ready", 1)).toBe(0.5);
        expect(playroomStartupRotationAtTick("ready", 2)).toBeCloseTo(Math.cos(0.02) * 0.5, 12);
        expect(playroomStartupRotationAtTick("ready", 158)).toBeCloseTo(Math.cos(3.14) * 0.5, 12);
    });

    it("keeps every image control square in viewport pixels", () => {
        expect(calculatePlayroomUiLayout(1280, 720)).toEqual({
            orientation: "landscape",
            startupActionSize: 192,
            kickSize: 256,
            nextSize: 256,
            replaySize: 256,
            freeSize: 153.6,
        });
        expect(calculatePlayroomUiLayout(720, 1280)).toEqual({
            orientation: "portrait",
            startupActionSize: 144,
            kickSize: 144,
            nextSize: 144,
            replaySize: 144,
            freeSize: 86.4,
        });
        expect(calculatePlayroomUiLayout(2000, 500).kickSize).toBe(200);
    });

    it("keeps startup and gameplay controls in separate phases", () => {
        expect(playroomUiVisibility("loading", 1, 0)).toEqual({
            startup: true,
            action: "loading",
            hud: false,
            kick: false,
            next: false,
            replay: false,
            free: false,
        });
        expect(playroomUiVisibility("ready", 1, 0).action).toBe("play");
        expect(playroomUiVisibility("ready", 1, 0).free).toBe(false);
        expect(playroomUiVisibility("aiming", 1, 0)).toMatchObject({ startup: false, hud: true, kick: true, next: false, replay: false, free: true });
        expect(playroomUiVisibility("watching", 2, 0)).toMatchObject({ startup: false, hud: true, kick: false, next: true, replay: false, free: true });
        expect(playroomUiVisibility("watching", 3, 0).next).toBe(false);
        expect(playroomUiVisibility("ended", 3, 0)).toMatchObject({ startup: false, hud: true, kick: false, next: false, replay: true, free: true });
        expect(playroomUiVisibility("free", 2, 0)).toMatchObject({ startup: false, hud: true, kick: false, next: false, replay: false, free: true });
    });
});
