import { describe, expect, it } from "vitest";
import { canAdvanceThrow, resetGameplayCounters } from "../../../lab/lite/src/demos/playroom/game.js";
import { isCameraMovementKey } from "../../../lab/lite/src/demos/playroom/input.js";
import type { PlayroomState } from "../../../lab/lite/src/demos/playroom/types.js";

describe("The Playroom game lifecycle", () => {
    it("permits exactly three throws and requires settled watching state", () => {
        const state = { phase: "watching", settlingFrames: 2, throwCount: 1 } as Pick<PlayroomState, "phase" | "settlingFrames" | "throwCount">;
        expect(canAdvanceThrow(state)).toBe(true);
        state.throwCount = 2;
        expect(canAdvanceThrow(state)).toBe(true);
        state.throwCount = 3;
        expect(canAdvanceThrow(state)).toBe(false);
        state.throwCount = 2;
        state.settlingFrames = 1;
        expect(canAdvanceThrow(state)).toBe(false);
    });

    it("resets gameplay state in-page without replacing persistent objects", () => {
        const state = { throwCount: 3, score: 91, scorePaused: false, scorePausedBeforeFree: false, poppersArmed: true, settlingFrames: 7 };
        resetGameplayCounters(state);
        expect(state).toEqual({ throwCount: 1, score: 0, scorePaused: true, scorePausedBeforeFree: true, poppersArmed: false, settlingFrames: 0 });
    });

    it("treats every supported free-camera movement key as charge-cancelling input", () => {
        for (const key of ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
            expect(isCameraMovementKey(key)).toBe(true);
        }
        expect(isCameraMovementKey("Space")).toBe(false);
    });
});
