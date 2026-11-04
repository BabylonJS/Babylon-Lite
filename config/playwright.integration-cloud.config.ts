/**
 * Nonvisual WebGPU readback tests on the same BrowserStack CDP/tunnel
 * infrastructure as parity. No scene bundles, golden captures, or perf runs.
 */
import { config as loadEnv } from "dotenv";
import { defineConfig } from "@playwright/test";
import { buildBrowserStackEndpoint } from "./browserstack-cdp";

loadEnv({ path: "../.env.local" });
loadEnv({ path: "../.env" });

const isCI = !!process.env.CI;
const useBrowserStack = !!(process.env.BROWSERSTACK_USERNAME && process.env.BROWSERSTACK_ACCESS_KEY);
const labTestPort = Number(process.env.LAB_TEST_PORT ?? 5179);
const swiftShaderArgs =
    isCI && !useBrowserStack
        ? ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-angle=swiftshader", "--disable-vulkan-fallback-to-gl-for-testing", "--ignore-gpu-blocklist"]
        : [];

export default defineConfig({
    testDir: "../tests/lite/integration",
    testMatch: ["gaussian-point-reprojection.spec.ts", "gaussian-point-sampling.spec.ts"],
    timeout: 90_000,
    retries: isCI ? 1 : 0,
    workers: 1,
    forbidOnly: isCI,
    outputDir: "../test-results/webgpu-integration-artifacts",
    reporter: [["list"], ["junit", { outputFile: "../test-results/webgpu-integration-junit.xml" }]],
    globalSetup: useBrowserStack ? "./browserstack-local-tunnel.ts" : undefined,
    use: {
        baseURL: `http://localhost:${labTestPort}`,
        headless: true,
        trace: "off",
        screenshot: "off",
        video: "off",
        ...(useBrowserStack
            ? { connectOptions: { wsEndpoint: buildBrowserStackEndpoint() } }
            : {
                  channel: "chrome",
                  launchOptions: {
                      args: ["--force-color-profile=srgb", "--enable-unsafe-webgpu", ...swiftShaderArgs],
                  },
              }),
    },
    webServer: {
        command: "pnpm --filter @babylon-lite/lab dev",
        port: labTestPort,
        env: { LAB_DEV_PORT: String(labTestPort) },
        reuseExistingServer: !isCI,
        timeout: 30_000,
    },
});
