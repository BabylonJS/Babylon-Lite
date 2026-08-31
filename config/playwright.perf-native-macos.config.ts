/**
 * Experimental performance configuration for Microsoft-hosted macOS agents.
 *
 * Current and baseline scenes run in local headless Chrome on the same agent.
 * The shared global setup verifies that Chrome can acquire a WebGPU adapter
 * before the performance comparison starts.
 */
import { defineConfig } from "@playwright/test";
import { NATIVE_MACOS_WEBGPU_ARGS } from "./playwright.native-macos-webgpu-setup";

export default defineConfig({
    testDir: "../tests/lite/perf",
    timeout: 600_000,
    retries: 4,
    workers: 1,
    fullyParallel: false,
    outputDir: "../test-results/perf-artifacts",
    reporter: [["html", { outputFolder: "../test-results/perf-report", open: "never" }], ["junit", { outputFile: "../test-results/perf-junit.xml" }], ["list"]],
    globalSetup: "./playwright.native-macos-webgpu-setup.ts",
    use: {
        channel: "chrome",
        headless: true,
        viewport: { width: 1280, height: 720 },
        trace: "off",
        launchOptions: {
            args: [...NATIVE_MACOS_WEBGPU_ARGS, "--enable-precise-memory-info"],
        },
    },
    webServer: {
        command: "pnpm --filter @babylon-lite/lab dev",
        port: 5174,
        reuseExistingServer: true,
        timeout: 30_000,
    },
});
