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
 * If lab/public/bundle/master-manifest.json is available, bundle-size increases
 * relative to master are emitted as warnings only; ceilings remain the blocker.
 */
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

import type { SceneConfig } from "./compare-utils";
import { IGNORED_BUNDLE_MODULE_PATTERN, summarizeRuntimeBundle } from "../../scripts/bundle-size-accounting";

const CONFIG_PATH = resolve(__dirname, "../../scene-config.json");
const BUNDLE_INFO_DIR = resolve(__dirname, "../../lab/public/bundle/bundle-info");
const MASTER_MANIFEST_PATH = resolve(__dirname, "../../lab/public/bundle/master-manifest.json");
const allScenes: SceneConfig[] = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const SCENES = allScenes.filter((s) => s.maxRawKB != null);

interface BundleManifestEntry {
    rawKB?: number;
}

type BundleManifest = Record<string, BundleManifestEntry>;

function loadMasterManifest(): BundleManifest | null {
    if (!existsSync(MASTER_MANIFEST_PATH)) {
        return null;
    }

    return JSON.parse(readFileSync(MASTER_MANIFEST_PATH, "utf-8")) as BundleManifest;
}

function roundedKB(value: number): number {
    return Math.round(value * 10) / 10;
}

const MASTER_MANIFEST = loadMasterManifest();

for (const scene of SCENES) {
    test(`${scene.name} bundle ≤ ${scene.maxRawKB} KB raw`, async ({ page }) => {
        const jsPayloads: { url: string; file: string; body: Buffer }[] = [];
        const responseReads: Promise<void>[] = [];

        // Intercept every JS response served from /bundle/
        page.on("response", (resp) => {
            const url = resp.url();
            if (url.includes("/bundle/") && url.endsWith(".js") && resp.ok()) {
                responseReads.push(
                    (async () => {
                        const body = await resp.body();
                        const file = url.split("/").pop()!.split("?")[0]!;
                        jsPayloads.push({ url, file, body });
                    })()
                );
            }
        });

        // Navigate to the bundle page and wait for the scene to finish rendering
        await page.goto(`/bundle-scene${scene.id}.html`);
        await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 50_000 });
        await Promise.all(responseReads);

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
        const sceneKey = `scene${scene.id}`;

        console.log(`  ${scene.name}: ${rawKB.toFixed(1)} KB raw (limit: ${scene.maxRawKB} KB), ${gzipKB.toFixed(1)} KB gzip (informational)`);
        const masterRawKB = MASTER_MANIFEST?.[sceneKey]?.rawKB;
        const currentRawKB = roundedKB(rawKB);
        if (masterRawKB != null && currentRawKB > masterRawKB) {
            console.warn(
                `  ⚠ ${scene.name}: bundle increased vs master by ${(currentRawKB - masterRawKB).toFixed(1)} KB raw (${currentRawKB.toFixed(1)} KB vs ${masterRawKB.toFixed(1)} KB)`
            );
        }
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
