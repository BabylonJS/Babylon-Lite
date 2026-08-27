/**
 * Playwright Config — Parity Tests via BrowserStack (CDP, sharded)
 *
 * Connects directly to remote Chrome on BrowserStack using Playwright's built-in
 * `connectOptions.wsEndpoint` — NO browserstack-node-sdk and NO browserstack.yml.
 * Each Playwright worker opens its own BrowserStack session, so the parity specs
 * shard across `workers` parallel cloud browsers instead of running serially on
 * one. That parallelism is the CI-time win for the parity job.
 *
 * Page sourcing: the local Vite dev server (webServer below, port 5174) serves
 * the parity scene pages, and the remote browser reaches it through a BrowserStack
 * Local tunnel opened in `browserstack-local-tunnel.ts` (globalSetup). Specs keep
 * navigating with baseURL-relative paths (e.g. goto("/scene1.html")); Playwright
 * derives baseURL from webServer.port.
 *
 * Worker count: `CIWORKERS` (exported by scripts/browserstack-wait.sh after it
 * grabs N BrowserStack sessions) sets the worker/shard count. Without it, defaults
 * to a single cloud worker so a bare invocation never over-claims capacity.
 *
 * Run in CI:   bash scripts/browserstack-wait.sh pnpm test:parity-cloud
 * Run locally: pnpm test:parity   (local Chrome — preferred for dev)
 *
 * Falls back to local Chrome (SwiftShader on CI) when BrowserStack credentials
 * are not available.
 */
import { config as loadEnv } from "dotenv";
import { defineConfig } from "@playwright/test";
import { buildBrowserStackEndpoint } from "./browserstack-cdp";

loadEnv({ path: "../.env.local" });
loadEnv({ path: "../.env" }); // also load .env if present

const isCI = !!process.env.CI;
const useBrowserStack = !!(process.env.BROWSERSTACK_USERNAME && process.env.BROWSERSTACK_ACCESS_KEY);

// Number of parallel BrowserStack sessions / Playwright workers. Set by the wait
// script in CI; defaults conservatively so a bare cloud run grabs one session.
const ciWorkers = process.env.CIWORKERS && Number(process.env.CIWORKERS) > 0 ? Number(process.env.CIWORKERS) : undefined;
const selectedSceneIds = process.env.AFFECTED_PARITY_SCENE_IDS?.split(",").filter(Boolean);

// SwiftShader flags for local CI fallback (no BrowserStack)
const swiftShaderArgs =
    isCI && !useBrowserStack
        ? ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-angle=swiftshader", "--disable-vulkan-fallback-to-gl-for-testing", "--ignore-gpu-blocklist"]
        : [];

export default defineConfig({
    testDir: "../tests/lite/parity/scenes",
    ...(selectedSceneIds?.length ? { testMatch: selectedSceneIds.map((id) => `scene${id}-*.spec.ts`) } : {}),
    timeout: 120_000,
    retries: 1,
    workers: ciWorkers ?? (useBrowserStack ? 1 : 2),
    // On CI, bail on the first failing test (after its retries) to save time;
    // locally we keep running so devs see every failure in one pass.
    maxFailures: isCI ? 1 : undefined,
    fullyParallel: true,
    outputDir: "../test-results/parity-artifacts",
    reporter: [["html", { outputFolder: "../test-results/parity-report", open: "never" }], ["junit", { outputFile: "../test-results/parity-junit.xml" }], ["list"]],
    // Start the BrowserStack Local tunnel (only when credentials are present).
    globalSetup: useBrowserStack ? "./browserstack-local-tunnel.ts" : undefined,
    use: {
        headless: true,
        viewport: { width: 1280, height: 720 },
        // Keep all tracing, including retry tracing, off: the BrowserStack
        // wsEndpoint embeds credentials that traces can capture.
        trace: "off",
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
        port: 5174,
        reuseExistingServer: true,
        timeout: 15_000,
    },
});
