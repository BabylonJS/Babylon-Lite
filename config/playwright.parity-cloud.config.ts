/**
 * Playwright Config — Parity Tests via BrowserStack
 *
 * Uses browserstack-node-sdk to run parity tests on a macOS Chrome instance
 * with real WebGPU support. The SDK reads browserstack.yml for platform config
 * and handles local tunneling automatically.
 *
 * Run locally:  npx browserstack-node-sdk playwright test --config playwright.parity-cloud.config.ts
 * Run in CI:    (handled by azure-pipelines.yml)
 *
 * Falls back to local Chrome (with SwiftShader on CI) when BrowserStack
 * credentials are not available.
 */
import { config as loadEnv } from "dotenv";
import { defineConfig } from "@playwright/test";

loadEnv({ path: "../.env.local" });
loadEnv({ path: "../.env" }); // also load .env if present

const isCI = !!process.env.CI;
const useBrowserStack = !!(process.env.BROWSERSTACK_USERNAME && process.env.BROWSERSTACK_ACCESS_KEY);

// SwiftShader flags for local CI fallback (no BrowserStack)
const swiftShaderArgs =
    isCI && !useBrowserStack
        ? ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-angle=swiftshader", "--disable-vulkan-fallback-to-gl-for-testing", "--ignore-gpu-blocklist"]
        : [];

export default defineConfig({
    testDir: "../tests/parity/scenes",
    timeout: 120_000,
    retries: 1,
    workers: 1,
    outputDir: "../test-results",
    reporter: [["html", { outputFolder: "../test-results/parity-report", open: "never" }], ["junit", { outputFile: "../test-results/parity-junit.xml" }], ["list"]],
    use: {
        // When run via `browserstack-node-sdk`, the SDK patches browser launch
        // to route through BrowserStack. No connectOptions needed.
        channel: "chrome",
        headless: true,
        viewport: { width: 1280, height: 720 },
        launchOptions: {
            args: ["--force-color-profile=srgb", "--enable-unsafe-webgpu", ...swiftShaderArgs],
        },
    },
    webServer: {
        command: "pnpm --filter lab dev",
        port: 5174,
        reuseExistingServer: true,
        timeout: 15_000,
    },
});
