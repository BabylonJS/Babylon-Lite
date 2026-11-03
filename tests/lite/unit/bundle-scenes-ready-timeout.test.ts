import { describe, expect, it, vi } from "vitest";

import { measurePage, readyTimeoutForScene } from "../../../scripts/bundle-scenes-core.js";

describe("bundle scene readiness timeout", () => {
    it("allows Kitchen's full temporal warmup without changing ordinary scene budgets", () => {
        expect(readyTimeoutForScene("scene348")).toBe(180_000);
        expect(readyTimeoutForScene("scene1")).toBe(50_000);
        expect(readyTimeoutForScene("scene129")).toBe(150_000);
        expect(readyTimeoutForScene("scene164")).toBe(150_000);
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

    it("still rejects a truncated Kitchen measurement when its extended budget expires", async () => {
        const timeout = new Error("not ready");
        timeout.name = "TimeoutError";
        const page = {
            on: vi.fn(),
            route: vi.fn(async () => undefined),
            goto: vi.fn(async () => undefined),
            waitForFunction: vi.fn(async () => {
                throw timeout;
            }),
            close: vi.fn(async () => undefined),
        };
        const browser = { newPage: vi.fn(async () => page) };
        await expect(measurePage(browser, 4173, "scene348", "lite/bundle-scene348.html", "/bundle/", true, readyTimeoutForScene("scene348"))).rejects.toThrow(
            "timed out after 180s waiting for canvas ready/error signal"
        );
        expect(page.close).toHaveBeenCalledOnce();
    });
});
