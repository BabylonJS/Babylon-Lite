/**
 * Playwright Config — Parity Tests via BrowserStack (CDP, sharded)
 *
 * Connects directly to remote Chrome on BrowserStack using Playwright's built-in
 * `connectOptions.wsEndpoint` — no browserstack-node-sdk and no browserstack.yml.
 * Each Playwright worker opens its own BrowserStack session, so the ~198 parity
 * specs are sharded across `workers` parallel cloud browsers instead of running
 * serially on one. This is the dominant CI-time win for the parity job.
 *
 * Page sourcing:
 *   - Public static site (CI): set PARITY_BASE_URL to the deployed parity site
 *     root (e.g. https://host/lite/<build>/parity-lab/lite/). The remote browser
 *     loads pages over the public internet — no Local tunnel. Scene assets come
 *     from public CDNs.
 *   - Local dev (no public URL): a local Vite dev server is started and used as
 *     baseURL. Note: the remote browser cannot reach localhost without a tunnel,
 *     so cloud runs require PARITY_BASE_URL — run `pnpm test:parity` for local.
 *
 * Worker count:
 *   `CIWORKERS` (exported by scripts/browserstack-wait.sh after it grabs N
 *   BrowserStack sessions) sets the worker/shard count. Without it, defaults to a
 *   single worker so a bare invocation never over-claims cloud capacity.
 *
 * Specs navigate with baseURL-relative paths (e.g. "scene1.html").
 *
 * Run in CI:   bash scripts/browserstack-wait.sh pnpm test:parity-cloud
 * Run locally: pnpm test:parity   (local Chrome — preferred for dev)
 *
 * Falls back to local Chrome (SwiftShader on CI) when BrowserStack credentials
 * are not available.
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

// Fail fast on a misconfigured cloud run: with credentials but no public base URL
// the remote BrowserStack browser cannot reach localhost (no Local tunnel), so it
// would grab a cloud session and then time out. Error before claiming any session.
if (useBrowserStack && !publicBaseUrl) {
    throw new Error(
        "[parity-cloud] BROWSERSTACK credentials are set but PARITY_BASE_URL is not. " +
            "Cloud runs need a public site URL (the remote browser cannot reach localhost). " +
            "Set PARITY_BASE_URL to the deployed parity site, or run `pnpm test:parity` for local Chrome."
    );
}

// Number of parallel BrowserStack sessions / Playwright workers. Set by the
// wait script in CI; defaults conservatively so a local run grabs one session.
const ciWorkers = process.env.CIWORKERS && Number(process.env.CIWORKERS) > 0 ? Number(process.env.CIWORKERS) : undefined;

// Build the BrowserStack CDP WebSocket endpoint from capabilities.
function buildBrowserStackEndpoint(): string {
    // Keep the capability in sync with the installed Playwright so it doesn't
    // silently drift after upgrades (BrowserStack validates this version).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const playwrightVersion: string = require("@playwright/test/package.json").version;
    const caps = {
        browser: process.env.BSTACK_BROWSER || "chrome",
        browser_version: process.env.BSTACK_BROWSER_VERSION || "latest",
        // macOS gives real WebGPU support; Windows VMs lack GPU acceleration.
        os: process.env.BSTACK_OS || "OS X",
        os_version: process.env.BSTACK_OS_VERSION || "Sonoma",
        project: "Babylon-Lite",
        build: process.env.BSTACK_BUILD_NAME || process.env.BROWSERSTACK_BUILD_NAME || "Babylon-Lite Parity",
        name: "Babylon-Lite Parity",
        "browserstack.username": process.env.BROWSERSTACK_USERNAME,
        "browserstack.accessKey": process.env.BROWSERSTACK_ACCESS_KEY,
        "browserstack.console": "errors",
        "browserstack.networkLogs": "false",
        "browserstack.debug": "false",
        "browserstack.idleTimeout": "300",
        "browserstack.playwrightVersion": playwrightVersion,
        // Pages are served from a public URL, so no Local tunnel is needed.
        "browserstack.local": "false",
    };
    // SECURITY: this URL embeds BROWSERSTACK_ACCESS_KEY. Keep the key secret in
    // the CI variable group, keep `trace` off (below), and do not publish raw
    // connection-error logs that may echo this URL.
    return `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify(caps))}`;
}

// SwiftShader flags for local CI fallback (no BrowserStack)
const swiftShaderArgs =
    isCI && !useBrowserStack
        ? ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-angle=swiftshader", "--disable-vulkan-fallback-to-gl-for-testing", "--ignore-gpu-blocklist"]
        : [];

// Only start a local dev server when there is no public site to load from.
const startLocalServer = !publicBaseUrl;

export default defineConfig({
    testDir: "../tests/lite/parity/scenes",
    timeout: 120_000,
    retries: 2,
    workers: ciWorkers ?? (useBrowserStack ? 1 : 2),
    fullyParallel: true,
    outputDir: "../test-results/parity-artifacts",
    reporter: [["html", { outputFolder: "../test-results/parity-report", open: "never" }], ["junit", { outputFile: "../test-results/parity-junit.xml" }], ["list"]],
    use: {
        baseURL: publicBaseUrl ?? "http://localhost:5174/",
        headless: true,
        viewport: { width: 1280, height: 720 },
        // Keep traces off: the BrowserStack wsEndpoint embeds the access key and
        // could otherwise be captured in published trace artifacts.
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
    // Local dev server (only when not loading from a public URL). Cloud runs use
    // PARITY_BASE_URL and never start this.
    webServer: startLocalServer
        ? {
              command: "pnpm --filter @babylon-lite/lab dev",
              port: 5174,
              reuseExistingServer: true,
              timeout: 15_000,
          }
        : undefined,
});
