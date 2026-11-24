import { describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: vi.fn() }));

describe("cloud performance server startup", () => {
    it("serves prepared bundles without downloading unrelated model fixtures", async () => {
        const { default: config } = await import("../../../config/playwright.perf-cloud.config");

        expect(config.webServer).toMatchObject({
            command: "pnpm --filter @babylon-lite/lab exec vite",
            port: 5174,
            reuseExistingServer: true,
            timeout: 180_000,
        });
        expect(config).toMatchObject({ timeout: 600_000, retries: 4, workers: 1, fullyParallel: false });
        expect(config.use).toMatchObject({ trace: "off", headless: true });
    });
});
