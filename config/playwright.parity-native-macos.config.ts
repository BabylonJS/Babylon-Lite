/**
 * Experimental parity configuration for Microsoft-hosted macOS agents.
 *
 * Chrome runs locally on the agent instead of connecting to BrowserStack. The
 * global setup probes Chrome's WebGPU adapter first and reports whether the
 * runner exposes Metal or a fallback implementation.
 */
import { defineConfig } from "@playwright/test";
import { NATIVE_MACOS_WEBGPU_ARGS } from "./playwright.native-macos-webgpu-setup";

const isCI = !!process.env.CI;
const ciWorkers = process.env.CIWORKERS && Number(process.env.CIWORKERS) > 0 ? Number(process.env.CIWORKERS) : 2;

export default defineConfig({
    testDir: "../tests/lite/parity/scenes",
    timeout: 120_000,
    retries: 1,
    workers: ciWorkers,
    maxFailures: isCI ? 1 : undefined,
    fullyParallel: true,
    outputDir: "../test-results/parity-artifacts",
    reporter: [["html", { outputFolder: "../test-results/parity-report", open: "never" }], ["junit", { outputFile: "../test-results/parity-junit.xml" }], ["list"]],
    globalSetup: "./playwright.native-macos-webgpu-setup.ts",
    use: {
        channel: "chrome",
        headless: true,
        viewport: { width: 1280, height: 720 },
        trace: "off",
        launchOptions: {
            args: NATIVE_MACOS_WEBGPU_ARGS,
        },
    },
    webServer: {
        command: "pnpm --filter @babylon-lite/lab dev",
        port: 5174,
        reuseExistingServer: true,
        timeout: 30_000,
    },
});
