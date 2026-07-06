/**
 * Shared BrowserStack CDP helpers for the parity-cloud Playwright config and its
 * Local-tunnel globalSetup. Keeping the wsEndpoint builder and localIdentifier in
 * one place ensures the tunnel and the remote browser sessions agree on the
 * `localIdentifier` and connect the same way.
 *
 * No browserstack-node-sdk / browserstack.yml is involved — parity connects to
 * remote Chrome purely over CDP. (The perf job still uses the SDK.)
 */

/**
 * Local tunnel identifier, shared by the tunnel (globalSetup) and the
 * `browserstack.localIdentifier` capability. Derived deterministically from the
 * environment so both the config process and the globalSetup child process
 * resolve the same value. In CI, set BSTACK_LOCAL_IDENTIFIER to a per-build
 * unique value so concurrent pipeline runs don't collide.
 */
export function localIdentifier(): string {
    return process.env.BSTACK_LOCAL_IDENTIFIER || "bstack-lite-parity";
}

/**
 * Build the BrowserStack CDP WebSocket endpoint from capabilities.
 *
 * SECURITY: the returned URL embeds BROWSERSTACK_ACCESS_KEY. Keep the key secret
 * in the CI variable group, keep Playwright `trace` off, and don't publish raw
 * connection-error logs that may echo this URL.
 */
export function buildBrowserStackEndpoint(): string {
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
        // Pages are served from the local Vite dev server and reached through a
        // BrowserStack Local tunnel (started in browserstack-local-tunnel.ts).
        "browserstack.local": "true",
        "browserstack.localIdentifier": localIdentifier(),
    };
    return `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify(caps))}`;
}
