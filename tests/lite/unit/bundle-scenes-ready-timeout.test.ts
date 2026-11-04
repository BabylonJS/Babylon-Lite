import { afterEach, describe, expect, it, vi } from "vitest";

import { measurePage, measurementBrowserArgs, readyTimeoutForScene } from "../../../scripts/bundle-scenes-core.js";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

function readinessBrowser(dataset: Record<string, string>) {
    const handlers: Record<string, ((error: Error) => void) | undefined> = {};
    vi.stubGlobal("document", { querySelector: () => ({ dataset }) });
    const page = {
        on: vi.fn((event: string, handler: (error: Error) => void) => {
            handlers[event] = handler;
        }),
        route: vi.fn(async () => undefined),
        goto: vi.fn(async () => undefined),
        waitForFunction: vi.fn(async (ready: () => boolean) => {
            if (!ready()) {
                const error = new Error("not ready");
                error.name = "TimeoutError";
                throw error;
            }
        }),
        evaluate: vi.fn(async (read: () => unknown) => read()),
        close: vi.fn(async () => undefined),
    };
    return { page, handlers, browser: { newPage: vi.fn(async () => page) } };
}

describe("bundle scene readiness timeout", () => {
    it("uses the normal budget for Kitchen's separate bundle readiness signal", () => {
        expect(readyTimeoutForScene("scene348")).toBe(50_000);
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

    it("still rejects a truncated Kitchen measurement when its budget expires", async () => {
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
            "timed out after 50s waiting for canvas ready/error signal"
        );
        expect(page.close).toHaveBeenCalledOnce();
    });

    it.each(["ready", "bundleReady"])("accepts the explicit %s signal without changing the other signal", async (signal) => {
        const dataset = { [signal]: "true" };
        const f = readinessBrowser(dataset);
        await measurePage(f.browser, 4173, "scene348", "lite/bundle-scene348.html", "/bundle/", true);
        expect(f.page.close).toHaveBeenCalledOnce();
        expect(dataset[signal === "ready" ? "bundleReady" : "ready"]).toBeUndefined();
    });

    it("rejects a reported error even when bundle readiness was set", async () => {
        const f = readinessBrowser({ bundleReady: "true", error: "GPU startup failed" });
        await expect(measurePage(f.browser, 4173, "scene348", "lite/bundle-scene348.html", "/bundle/", true)).rejects.toThrow("GPU startup failed");
    });

    it("keeps uncaught render errors in readiness failure diagnostics", async () => {
        const f = readinessBrowser({});
        f.page.goto.mockImplementation(async () => {
            f.handlers.pageerror?.(new Error("render failed"));
        });
        await expect(measurePage(f.browser, 4173, "scene348", "lite/bundle-scene348.html", "/bundle/", true)).rejects.toThrow("uncaught page errors: render failed");
    });

    it("selects an available software adapter without forcing Windows' Vulkan compositor", () => {
        vi.stubEnv("CI", "");
        vi.stubEnv("BUNDLE_SOFTWARE_RENDER", "true");
        const args = measurementBrowserArgs();
        expect(args).toContain("--enable-unsafe-webgpu");
        if (process.platform === "win32") {
            expect(args).toContain("--use-webgpu-adapter=swiftshader");
            expect(args).not.toContain("--enable-features=Vulkan");
        } else {
            expect(args).toContain("--use-vulkan=swiftshader");
        }
    });
});
