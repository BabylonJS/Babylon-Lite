/**
 * Loads .env.local (if present) then spawns browserstack-node-sdk with
 * the remaining argv. This ensures BrowserStack credentials from .env.local
 * are available as env vars before the SDK reads browserstack.yml.
 */
import { config } from "dotenv";
import { execSync } from "child_process";
import { resolve } from "path";

config({ path: ".env.local" });
config(); // .env fallback

// Derive a descriptive build name from the Playwright config being used
const args = process.argv.slice(2).join(" ");

// Tell the SDK where to find browserstack.yml (not at root).
process.env.BROWSERSTACK_CONFIG_FILE = resolve(__dirname, "../config/browserstack.yml");

// Drive the Local tunnel (browserstack.yml `browserstackLocal: ${BROWSERSTACK_LOCAL}`).
// When parity runs against a public static site (PARITY_BASE_URL set), the remote
// browser loads pages over the public internet and scene assets come from public
// CDNs, so no tunnel is needed. Otherwise tests hit a local dev server and the
// tunnel is required. Respect an explicit BROWSERSTACK_LOCAL if the caller set one.
if (process.env.BROWSERSTACK_LOCAL == null) {
    process.env.BROWSERSTACK_LOCAL = process.env.PARITY_BASE_URL ? "false" : "true";
}

if (!process.env.BROWSERSTACK_BUILD_NAME) {
    if (args.includes("perf-cloud")) {
        process.env.BROWSERSTACK_BUILD_NAME = "Babylon-Lite Perf";
    } else if (args.includes("parity-cloud")) {
        process.env.BROWSERSTACK_BUILD_NAME = "Babylon-Lite Parity";
    } else {
        process.env.BROWSERSTACK_BUILD_NAME = "Babylon-Lite CI";
    }
}
try {
    execSync(`npx browserstack-node-sdk ${args}`, { stdio: "inherit", env: process.env });
} catch (e: any) {
    process.exit(e.status ?? 1);
}
