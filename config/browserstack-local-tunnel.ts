/**
 * Playwright globalSetup — BrowserStack Local tunnel for the parity job.
 *
 * The parity-cloud config connects to a remote BrowserStack browser over CDP
 * (no browserstack-node-sdk). The remote browser still needs to reach the local
 * Vite dev server (http://localhost:5174) that serves the parity scene pages, so
 * we open a BrowserStack Local tunnel here and tear it down after the run.
 *
 * The tunnel's `localIdentifier` MUST match the `browserstack.localIdentifier`
 * capability in playwright.parity-cloud.config.ts — both read it from the same
 * env-derived value (see localIdentifier() in browserstack-cdp.ts).
 *
 * No-op when BrowserStack credentials are absent (local dev runs against a real
 * GPU without a tunnel).
 */
import { config as loadEnv } from "dotenv";
import * as BrowserStackLocal from "browserstack-local";
import { localIdentifier } from "./browserstack-cdp";

loadEnv({ path: "../.env.local" });
loadEnv({ path: "../.env" });

export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
    const username = process.env.BROWSERSTACK_USERNAME;
    const accessKey = process.env.BROWSERSTACK_ACCESS_KEY;

    if (!username || !accessKey) {
        console.log("[parity-cloud] No BrowserStack credentials — skipping Local tunnel (local run).");
        return;
    }

    const bsLocal = new BrowserStackLocal.Local();
    const localId = localIdentifier();

    await new Promise<void>((resolve, reject) => {
        bsLocal.start({ key: accessKey, localIdentifier: localId, force: true, forceLocal: true }, (error?: Error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });

    console.log(`[parity-cloud] BrowserStack Local tunnel started (localIdentifier=${localId}).`);

    return async function globalTeardown(): Promise<void> {
        if (!bsLocal.isRunning()) {
            return;
        }
        await new Promise<void>((resolve) => bsLocal.stop(() => resolve()));
        console.log("[parity-cloud] BrowserStack Local tunnel stopped.");
    };
}
