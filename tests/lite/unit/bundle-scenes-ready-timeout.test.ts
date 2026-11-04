import { Server } from "http";
import type * as FileSystem from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { measureLiteSceneWithRetry, measureLiveSizes, measurePage } from "../../../scripts/bundle-scenes-core.js";

const owned = vi.hoisted(() => ({
    launch: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
}));

vi.mock("@playwright/test", () => ({ chromium: { launch: owned.launch } }));
vi.mock("fs", async (importOriginal) => ({
    ...(await importOriginal<typeof FileSystem>()),
    writeFileSync: owned.writeFileSync,
    renameSync: owned.renameSync,
    mkdirSync: owned.mkdirSync,
}));

function measurementBrowser(error?: string, scene = "scene8") {
    const runtime = Buffer.from("export const ready=true;");
    const response = {
        url: () => `http://localhost:4173/bundle/${scene}.js`,
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
    return { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined), page, runtime };
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

    describe("bundle measurement resource ownership", () => {
        beforeEach(() => {
            owned.launch.mockReset();
            owned.writeFileSync.mockClear();
            owned.renameSync.mockClear();
            owned.mkdirSync.mockClear();
            vi.spyOn(console, "log").mockImplementation(() => undefined);
            vi.spyOn(console, "warn").mockImplementation(() => undefined);
        });

        afterEach(() => vi.restoreAllMocks());

        it("keeps the replacement browser for later scenes and closes it after the run", async () => {
            const closeServer = vi.spyOn(Server.prototype, "close");
            const failed = measurementBrowser("simulated failed initialization");
            const recovered = measurementBrowser();
            const nextScene = measurementBrowser(undefined, "scene349");
            recovered.newPage.mockResolvedValueOnce(recovered.page).mockResolvedValueOnce(nextScene.page);
            owned.launch.mockResolvedValueOnce(failed).mockResolvedValueOnce(recovered);

            const result = await measureLiveSizes(["scene8", "scene349"], [], false);

            expect(result.scene8).toMatchObject({ rawBytes: recovered.runtime.byteLength, runtimeChunks: ["scene8.js"] });
            expect(result.scene349).toMatchObject({ rawBytes: nextScene.runtime.byteLength, runtimeChunks: ["scene349.js"] });
            expect(owned.launch).toHaveBeenCalledTimes(2);
            expect(owned.launch.mock.calls[0]).toEqual(owned.launch.mock.calls[1]);
            expect(failed.newPage).toHaveBeenCalledOnce();
            expect(failed.close).toHaveBeenCalledOnce();
            expect(recovered.newPage).toHaveBeenCalledTimes(2);
            expect(recovered.close).toHaveBeenCalledOnce();
            expect(closeServer).toHaveBeenCalledOnce();
            expect(closeServer.mock.instances[0]).toHaveProperty("listening", false);
        });

        it("closes every attempted browser and the server without publishing failed measurements", async () => {
            const closeServer = vi.spyOn(Server.prototype, "close");
            const browsers = Array.from({ length: 3 }, () => measurementBrowser("simulated persistent initialization failure"));
            for (const browser of browsers) {
                owned.launch.mockResolvedValueOnce(browser);
            }

            await expect(measureLiveSizes(["scene8"], [], false)).rejects.toThrow("Failed to measure scene8 after 3 attempts");

            for (const browser of browsers) {
                expect(browser.newPage).toHaveBeenCalledOnce();
                expect(browser.close).toHaveBeenCalledOnce();
            }
            expect(owned.launch).toHaveBeenCalledTimes(3);
            expect(owned.writeFileSync).not.toHaveBeenCalled();
            expect(closeServer).toHaveBeenCalledOnce();
            expect(closeServer.mock.instances[0]).toHaveProperty("listening", false);
        });

        it("does not retain an already-closed browser when its replacement fails to launch", async () => {
            const closeServer = vi.spyOn(Server.prototype, "close");
            const failed = measurementBrowser("simulated failed initialization");
            const launchError = new Error("simulated replacement launch failure");
            owned.launch.mockResolvedValueOnce(failed).mockRejectedValueOnce(launchError);

            await expect(measureLiveSizes(["scene8"], [], false)).rejects.toBe(launchError);

            expect(failed.close).toHaveBeenCalledOnce();
            expect(owned.writeFileSync).not.toHaveBeenCalled();
            expect(closeServer).toHaveBeenCalledOnce();
            expect(closeServer.mock.instances[0]).toHaveProperty("listening", false);
        });

        it("closes the server when the initial browser never launches", async () => {
            const closeServer = vi.spyOn(Server.prototype, "close");
            const launchError = new Error("simulated initial launch failure");
            owned.launch.mockRejectedValueOnce(launchError);

            await expect(measureLiveSizes(["scene8"], [], false)).rejects.toBe(launchError);

            expect(owned.launch).toHaveBeenCalledOnce();
            expect(owned.writeFileSync).not.toHaveBeenCalled();
            expect(closeServer).toHaveBeenCalledOnce();
            expect(closeServer.mock.instances[0]).toHaveProperty("listening", false);
        });
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
