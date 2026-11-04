import { describe, expect, it, vi } from "vitest";

import { measureLiteSceneWithRetry, measurePage } from "../../../scripts/bundle-scenes-core.js";

function measurementBrowser(error?: string) {
    const runtime = Buffer.from("export const ready=true;");
    const response = {
        url: () => "http://localhost:4173/bundle/scene8.js",
        ok: () => true,
        body: async () => runtime,
    };
    const page = {
        on: vi.fn((_event: string, listener: (value: typeof response) => void) => listener(response)),
        route: vi.fn(async () => undefined),
        goto: vi.fn(async () => undefined),
        waitForFunction: vi.fn(async () => undefined),
        evaluate: vi.fn(async () => error),
        close: vi.fn(async () => undefined),
    };
    return { newPage: vi.fn(async () => page), page, runtime };
}

describe("bundle scene readiness timeout", () => {
    it("does not restart a browser that successfully measures the scene", async () => {
        const browser = measurementBrowser();
        const restart = vi.fn();
        await expect(measureLiteSceneWithRetry(browser, 4173, "scene8", restart)).resolves.toMatchObject({
            rawBytes: browser.runtime.byteLength,
            chunks: ["scene8.js"],
        });
        expect(restart).not.toHaveBeenCalled();
        expect(browser.page.close).toHaveBeenCalledOnce();
    });

    it("retries a rejected measurement in a fresh browser instead of returning partial bytes", async () => {
        const failed = measurementBrowser();
        const timeout = new Error("simulated scene readiness timeout");
        timeout.name = "TimeoutError";
        failed.page.waitForFunction.mockRejectedValue(timeout);
        const recovered = measurementBrowser();
        const restart = vi.fn().mockResolvedValue(recovered);
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
            await expect(measureLiteSceneWithRetry(failed, 4173, "scene8", restart)).resolves.toMatchObject({
                rawBytes: recovered.runtime.byteLength,
                chunks: ["scene8.js"],
            });
            expect(failed.newPage).toHaveBeenCalledOnce();
            expect(failed.page.close).toHaveBeenCalledOnce();
            expect(restart).toHaveBeenCalledOnce();
            expect(recovered.newPage).toHaveBeenCalledOnce();
            expect(recovered.page.close).toHaveBeenCalledOnce();
            expect(failed.page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), undefined, { timeout: 50_000 });
            expect(recovered.page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), undefined, { timeout: 50_000 });
        } finally {
            warning.mockRestore();
        }
    });

    it("preserves the retry bound and fails when every fresh browser reports an error", async () => {
        const failed = measurementBrowser("simulated persistent GPU initialization failure");
        const retry = measurementBrowser("simulated persistent GPU initialization failure");
        const restart = vi.fn().mockResolvedValue(retry);
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
            await expect(measureLiteSceneWithRetry(failed, 4173, "scene8", restart)).rejects.toThrow("Failed to measure scene8 after 3 attempts");
            expect(failed.newPage).toHaveBeenCalledOnce();
            expect(restart).toHaveBeenCalledTimes(2);
            expect(retry.newPage).toHaveBeenCalledTimes(2);
        } finally {
            warning.mockRestore();
        }
    });

    it("propagates browser restart failures without recording a measurement", async () => {
        const failed = measurementBrowser("simulated failed GPU initialization");
        const launchError = new Error("simulated browser launch failure");
        const restart = vi.fn().mockRejectedValue(launchError);
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
            await expect(measureLiteSceneWithRetry(failed, 4173, "scene8", restart)).rejects.toBe(launchError);
            expect(restart).toHaveBeenCalledOnce();
        } finally {
            warning.mockRestore();
        }
    });

    it("passes the per-scene timeout as waitForFunction options", async () => {
        const sentinel = new Error("stop after waitForFunction");
        const waitForFunction = vi.fn(async () => {
            throw sentinel;
        });
        const page = {
            on: vi.fn(),
            route: vi.fn(async () => undefined),
            goto: vi.fn(async () => undefined),
            waitForFunction,
            close: vi.fn(async () => undefined),
        };
        const browser = {
            newPage: vi.fn(async () => page),
        };

        await expect(measurePage(browser, 4173, "scene129", "lite/bundle-scene129.html", "/bundle/", true, 150_000)).rejects.toBe(sentinel);

        expect(waitForFunction).toHaveBeenCalledWith(expect.any(Function), undefined, { timeout: 150_000 });
    });
});
