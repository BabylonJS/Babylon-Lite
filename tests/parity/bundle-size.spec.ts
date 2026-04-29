/**
 * Bundle Size Regression Tests (Live)
 *
 * Loads each bundle-sceneN.html in a real browser via Playwright, intercepts
 * network responses, and measures only the JS bytes actually fetched at
 * runtime, minus local *-nme.ts graph payload modules. Dynamic-import chunks
 * that are never loaded (e.g. animation-group for a static model) are correctly
 * excluded.
 *
 * Requires pre-built bundles in lab/public/bundle/.
 * The Playwright webServer config (playwright.config.ts) starts the dev server
 * automatically.
 *
 * Ceilings are set ~5 KB above baseline to catch regressions while allowing
 * natural growth.  Per-scene ceilings live in scene-config.json (maxRawKB).
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";

import type { SceneConfig } from "./compare-utils";
import { IGNORED_BUNDLE_MODULE_PATTERN, summarizeRuntimeBundle } from "../../scripts/bundle-size-accounting";

const CONFIG_PATH = resolve(__dirname, "../../scene-config.json");
const BUNDLE_INFO_DIR = resolve(__dirname, "../../lab/public/bundle/bundle-info");
const allScenes: SceneConfig[] = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const SCENES = allScenes.filter((s) => s.maxRawKB != null);

for (const scene of SCENES) {
    test(`${scene.name} bundle ≤ ${scene.maxRawKB} KB raw`, async ({ page }) => {
        const jsPayloads: { url: string; file: string; body: Buffer }[] = [];

        // Intercept every JS response served from /bundle/
        page.on("response", async (resp) => {
            const url = resp.url();
            if (url.includes("/bundle/") && url.endsWith(".js") && resp.ok()) {
                const body = await resp.body();
                const file = url.split("/").pop()!.split("?")[0]!;
                jsPayloads.push({ url, file, body });
            }
        });

        // Navigate to the bundle page and wait for the scene to finish rendering
        await page.goto(`/bundle-scene${scene.id}.html`);
        await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 50_000 });

        // Tally raw + gzipped sizes of all JS that was actually loaded (gzip is informational only).
        // Local serialized NME scene data is ignored so ceilings track runtime code.
        const details: string[] = [];
        for (const { url, body } of jsPayloads) {
            const rawKB = body.length / 1024;
            const file = url.split("/").pop()!;
            details.push(`    ${file}: ${rawKB.toFixed(1)} KB raw`);
        }
        const summary = summarizeRuntimeBundle(jsPayloads, BUNDLE_INFO_DIR, `scene${scene.id}`);
        const rawKB = summary.rawBytes / 1024;
        const gzipKB = summary.gzipBytes / 1024;
        const ignoredRawKB = summary.ignoredRawBytes / 1024;

        console.log(`  ${scene.name}: ${rawKB.toFixed(1)} KB raw (limit: ${scene.maxRawKB} KB), ${gzipKB.toFixed(1)} KB gzip (informational)`);
        if (summary.ignoredRawBytes > 0) {
            console.log(`  Ignored ${ignoredRawKB.toFixed(1)} KB raw from local ${IGNORED_BUNDLE_MODULE_PATTERN} modules:`);
            for (const module of summary.ignoredModules) {
                console.log(`    ${module.id} (${module.chunk}): ${(module.bytes / 1024).toFixed(1)} KB raw`);
            }
        }
        console.log(`  Files loaded (${jsPayloads.length}):`);
        for (const d of details) {
            console.log(d);
        }

        expect(rawKB, `raw ${rawKB.toFixed(1)} KB exceeds ceiling ${scene.maxRawKB} KB (+${(rawKB - scene.maxRawKB!).toFixed(1)} KB over)`).toBeLessThanOrEqual(scene.maxRawKB!);

        // Pure-2D ceiling: scenes 50/51 must NOT pull any scene/* code.
        if (scene.slug === "scene50-sprite-grid" || scene.slug === "scene51-sprite-grid") {
            const forbidden = /scene-core|scene-camera|scene-node|asset-container/;
            const offenders = jsPayloads.map((p) => p.url.split("/").pop()!).filter((f) => forbidden.test(f));
            expect(offenders, `pure-2D ${scene.slug} must not load scene/* chunks; found: ${offenders.join(", ")}`).toEqual([]);
        }
    });
}
