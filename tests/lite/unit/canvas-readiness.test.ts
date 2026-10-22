import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { waitForCanvasReady } from "../../shared/compare-core";

function pageSpy(states: { done: boolean; error: string | null }[]): { page: Page; evaluate: ReturnType<typeof vi.fn>; wait: ReturnType<typeof vi.fn> } {
    const evaluate = vi.fn();
    for (const state of states) {
        evaluate.mockResolvedValueOnce(state);
    }
    const wait = vi.fn().mockImplementation(async (ms: number) => {
        vi.setSystemTime(Date.now() + ms);
    });
    return { page: { evaluate, waitForTimeout: wait } as unknown as Page, evaluate, wait };
}

afterEach(() => vi.useRealTimers());

describe("canvas readiness", () => {
    it("returns immediately when ready", async () => {
        const spy = pageSpy([{ done: true, error: null }]);

        await waitForCanvasReady(spy.page, { timeout: 1000, label: "Lite scene 112" });

        expect(spy.evaluate).toHaveBeenCalledWith(expect.any(Function), "ready");
        expect(spy.wait).not.toHaveBeenCalled();
    });

    it("fails with the original scene error without waiting for the deadline", async () => {
        const spy = pageSpy([{ done: false, error: "KHR_texture_basisu: failed to load image 503" }]);

        await expect(waitForCanvasReady(spy.page, { timeout: 150_000, label: "Lite scene 112" })).rejects.toThrow(
            "Lite scene 112 failed to initialize: KHR_texture_basisu: failed to load image 503"
        );

        expect(spy.wait).not.toHaveBeenCalled();
    });

    it("sends a new browser command on each poll while loading", async () => {
        vi.useFakeTimers();
        const spy = pageSpy([
            { done: false, error: null },
            { done: false, error: null },
            { done: true, error: null },
        ]);

        await waitForCanvasReady(spy.page, { timeout: 5000, label: "Lite scene 121" });

        expect(spy.evaluate).toHaveBeenCalledTimes(3);
        expect(spy.wait.mock.calls).toEqual([[1000], [1000]]);
    });

    it("reports an initialization timeout rather than closing the browser", async () => {
        vi.useFakeTimers();
        const spy = pageSpy([
            { done: false, error: null },
            { done: false, error: null },
            { done: false, error: null },
        ]);

        await expect(waitForCanvasReady(spy.page, { timeout: 1000, label: "Lite scene 121" })).rejects.toThrow(
            'Lite scene 121: timed out after 1000ms waiting for canvas.dataset.ready === "true"'
        );
    });
});
