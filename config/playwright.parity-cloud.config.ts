/**
 * Playwright Config — Parity Tests via BrowserStack
 *
 * Uses browserstack-node-sdk to run parity tests on a macOS Chrome instance
 * with real WebGPU support. The SDK reads browserstack.yml for platform config.
 *
 * Page sourcing (two modes):
 *   1. Public static site (preferred, no tunnel) — set PARITY_BASE_URL to the
 *      deployed parity site root (e.g. https://host/lite/<build>/lab/lite/).
 *      The remote browser loads pages directly over the public internet, so the
 *      BrowserStack Local tunnel is disabled (config/browserstack.yml). Scene
 *      assets already come from public CDNs, so nothing is tunneled.
 *   2. Local dev server (fallback) — when PARITY_BASE_URL is unset, a local Vite
 *      dev server is started and reached through the BrowserStack Local tunnel.
 *
 * Specs navigate with baseURL-relative paths (e.g. "scene1.html"), so the same
 * specs work against either a path-prefixed public host or localhost.
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

// Public parity site root. When set, the remote browser loads pages from this
// URL and no local dev server / tunnel is needed. Must end in a trailing slash
// so relative goto("sceneN.html") resolves under the deploy path prefix.
const rawBaseUrl = process.env.PARITY_BASE_URL?.trim();
const publicBaseUrl = rawBaseUrl ? (rawBaseUrl.endsWith("/") ? rawBaseUrl : `${rawBaseUrl}/`) : undefined;

// SwiftShader flags for local CI fallback (no BrowserStack)
const swiftShaderArgs =
    isCI && !useBrowserStack
        ? ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-angle=swiftshader", "--disable-vulkan-fallback-to-gl-for-testing", "--ignore-gpu-blocklist"]
        : [];

export default defineConfig({
    testDir: "../tests/lite/parity/scenes",
    timeout: 120_000,
    retries: 1,
    workers: 1,
    outputDir: "../test-results/parity-artifacts",
    reporter: [["html", { outputFolder: "../test-results/parity-report", open: "never" }], ["junit", { outputFile: "../test-results/parity-junit.xml" }], ["list"]],
    use: {
        // When run via `browserstack-node-sdk`, the SDK patches browser launch
        // to route through BrowserStack. No connectOptions needed.
        baseURL: publicBaseUrl ?? "http://localhost:5174/",
        channel: "chrome",
        headless: true,
        viewport: { width: 1280, height: 720 },
        launchOptions: {
            args: ["--force-color-profile=srgb", "--enable-unsafe-webgpu", ...swiftShaderArgs],
        },
    },
    // Only spin up a local dev server (reached via the Local tunnel) when no
    // public parity site URL is provided.
    webServer: publicBaseUrl
        ? undefined
        : {
              command: "pnpm --filter @babylon-lite/lab dev",
              port: 5174,
              reuseExistingServer: true,
              timeout: 15_000,
          },
});
