import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: vi.fn() }));
vi.mock("@playwright/test", () => ({ defineConfig: (config: unknown) => config }));
vi.mock("../../../config/browserstack-cdp", () => ({
    buildBrowserStackEndpoint: () => "wss://example.invalid/integration",
}));

beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("CI", "true");
    vi.stubEnv("LAB_TEST_PORT", "5194");
});

afterEach(() => vi.unstubAllEnvs());

describe("nonvisual cloud integration startup", () => {
    it.each(["local", "BrowserStack"])("starts Vite without model downloads for the %s target", async (target) => {
        vi.stubEnv("BROWSERSTACK_USERNAME", target === "BrowserStack" ? "test-user" : "");
        vi.stubEnv("BROWSERSTACK_ACCESS_KEY", target === "BrowserStack" ? "test-key" : "");
        const { default: config } = await import("../../../config/playwright.integration-cloud.config");

        expect(config.webServer).toMatchObject({
            command: "pnpm --filter @babylon-lite/lab exec vite",
            port: 5194,
            env: { LAB_DEV_PORT: "5194" },
            reuseExistingServer: false,
            timeout: 30_000,
        });
        expect(config.testMatch).toEqual(["gaussian-point-reprojection.spec.ts", "gaussian-point-sampling.spec.ts"]);
        expect(config.use).toMatchObject({ trace: "off", screenshot: "off", video: "off" });
    });
});
