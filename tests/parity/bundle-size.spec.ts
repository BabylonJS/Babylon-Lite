/**
 * Bundle Size Regression Tests (Live)
 *
 * Loads each bundle-sceneN.html in a real browser via Playwright, intercepts
 * network responses, and measures only the JS bytes actually fetched at
 * runtime.  Dynamic-import chunks that are never loaded (e.g. animation-group
 * for a static model) are correctly excluded.
 *
 * Requires pre-built bundles in apps/manual-lab/public/bundle/.
 * The Playwright webServer config (playwright.config.ts) starts the dev server
 * automatically.
 *
 * Ceilings are set ~5 KB above baseline to catch regressions while allowing
 * natural growth.  Per-scene ceilings live in scene-config.json (maxRawKB / maxGzipKB).
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { gzipSync } from "zlib";

import type { SceneConfig } from "./compare-utils";

const CONFIG_PATH = resolve(__dirname, "../../scene-config.json");
const allScenes: SceneConfig[] = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const SCENES = allScenes.filter((s) => s.maxRawKB != null && s.maxGzipKB != null);

for (const scene of SCENES) {
    test(`${scene.name} bundle ≤ ${scene.maxRawKB} KB raw, ≤ ${scene.maxGzipKB} KB gzip`, async ({ page }) => {
        const jsPayloads: { url: string; body: Buffer }[] = [];

        // Intercept every JS response served from /bundle/
        page.on("response", async (resp) => {
            const url = resp.url();
            if (url.includes("/bundle/") && url.endsWith(".js") && resp.ok()) {
                const body = await resp.body();
                jsPayloads.push({ url, body });
            }
        });

        // Navigate to the bundle page and wait for the scene to finish rendering
        await page.goto(`/bundle-scene${scene.id}.html`);
        await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });

        // Tally raw + gzipped sizes of all JS that was actually loaded
        let totalRaw = 0;
        let totalGzip = 0;
        const details: string[] = [];
        for (const { url, body } of jsPayloads) {
            const rawKB = body.length / 1024;
            const gzKB = gzipSync(body, { level: 9 }).length / 1024;
            totalRaw += rawKB;
            totalGzip += gzKB;
            const file = url.split("/").pop()!;
            details.push(`    ${file}: ${rawKB.toFixed(1)} KB raw, ${gzKB.toFixed(1)} KB gzip`);
        }
        const rawKB = totalRaw;
        const gzipKB = totalGzip;

        console.log(`  ${scene.name}: ${rawKB.toFixed(1)} KB raw (limit: ${scene.maxRawKB} KB), ${gzipKB.toFixed(1)} KB gzip (limit: ${scene.maxGzipKB} KB)`);
        console.log(`  Files loaded (${jsPayloads.length}):`);
        for (const d of details) {
            console.log(d);
        }

        expect(rawKB, `raw bundle should be ≤ ${scene.maxRawKB} KB`).toBeLessThanOrEqual(scene.maxRawKB!);
        expect(gzipKB, `gzipped bundle should be ≤ ${scene.maxGzipKB} KB`).toBeLessThanOrEqual(scene.maxGzipKB!);
    });
}
