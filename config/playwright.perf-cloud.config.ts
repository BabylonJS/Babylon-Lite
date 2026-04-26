/**
 * Playwright Config — Perf Tests via BrowserStack
 *
 * Runs Lite-vs-BJS performance regression tests on a BrowserStack macOS Chrome
 * instance with real GPU. Uses browserstack-node-sdk for connection & tunneling.
 *
 * Run:  npx browserstack-node-sdk playwright test --config playwright.perf-cloud.config.ts tests/perf/perf-regression.spec.ts
 */
import { config as loadEnv } from "dotenv";
import { defineConfig } from "@playwright/test";

loadEnv({ path: "../.env.local" });
loadEnv({ path: "../.env" }); // also load .env if present

export default defineConfig({
    testDir: "../tests/perf",
    timeout: 600_000,
    retries: 4,
    workers: 5,
    fullyParallel: true,
    outputDir: "../test-results",
    reporter: [["html", { outputFolder: "../test-results/perf-report", open: "never" }], ["junit", { outputFile: "../test-results/perf-junit.xml" }], ["list"]],
    use: {
        channel: "chrome",
        headless: true,
        viewport: { width: 1280, height: 720 },
        launchOptions: {
            args: ["--force-color-profile=srgb", "--enable-precise-memory-info", "--enable-unsafe-webgpu"],
        },
    },
    webServer: {
        command: "pnpm --filter lab dev",
        port: 5174,
        reuseExistingServer: true,
        timeout: 15_000,
    },
});
