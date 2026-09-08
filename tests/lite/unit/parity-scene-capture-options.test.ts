import { describe, expect, it } from "vitest";
import { buildParitySceneQuery, getParitySceneCaptureOptions } from "../parity/scene-capture-options";

describe("canonical parity scene capture options", () => {
    it.each([
        [5, "?seekTime=2", "animationFrozen", 60_000],
        [40, "?captureFrame=120", "captureReady", 60_000],
        [171, "?freeze=1", undefined, 180_000],
    ] as const)("uses the browser capture state for scene %i", (sceneId, query, expectedFlag, timeoutMs) => {
        const options = getParitySceneCaptureOptions(sceneId);
        const waitFlag = options.waitFlag ?? (options.seekTime === undefined ? undefined : "animationFrozen");

        expect(buildParitySceneQuery(options)).toBe(query);
        expect(waitFlag).toBe(expectedFlag);
        expect(options.timeoutMs).toBe(timeoutMs);
    });

    it("combines seek time and additional query parameters", () => {
        expect(buildParitySceneQuery({ seekTime: 2, queryParams: "freeze=1" })).toBe("?seekTime=2&freeze=1");
    });
});
