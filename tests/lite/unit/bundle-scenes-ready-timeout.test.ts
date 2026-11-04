import { describe, expect, it, vi } from "vitest";

import { measurePage } from "../../../scripts/bundle-scenes-core.js";

describe("bundle scene readiness timeout", () => {
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
