/**
 * Bundle Size Delta Regression Test
 *
 * Compares current bundle sizes against the committed baseline
 * (baselines/bundle-size.json). Fails if any scene's bundle size has
 * grown beyond the allowed delta threshold.
 *
 * The absolute ceiling checks remain in bundle-size.spec.ts — this test
 * adds relative regression detection against the last known release baseline.
 *
 * Env:  BUNDLE_DELTA_PCT=5  — allowed % increase (default: 5)
 *
 * Run:  npx playwright test tests/parity/bundle-size-delta.spec.ts
 */
import { test, expect } from "@playwright/test";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { gzipSync } from "zlib";

import type { SceneConfig } from "./compare-utils";

const DELTA_PCT = Number(process.env.BUNDLE_DELTA_PCT) || 5;

const CONFIG_PATH = resolve(__dirname, "../../scene-config.json");
const BASELINE_PATH = resolve(__dirname, "../../baselines/bundle-size.json");

interface BundleSizeEntry {
    rawKB: number;
    gzipKB: number;
}

interface BundleSizeBaseline {
    scenes: Record<string, BundleSizeEntry>;
}

const allScenes: SceneConfig[] = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

// Only run delta tests if a baseline exists and has been populated (non-zero values)
const hasBaseline = existsSync(BASELINE_PATH);
const baseline: BundleSizeBaseline | null = hasBaseline ? JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) : null;

function baselineForScene(sceneId: number): BundleSizeEntry | null {
    if (!baseline) return null;
    const entry = baseline.scenes[`scene${sceneId}`];
    // Skip zero baselines (not yet populated)
    if (!entry || (entry.rawKB === 0 && entry.gzipKB === 0)) return null;
    return entry;
}

const scenesWithBaseline = allScenes.filter((s) => baselineForScene(s.id) !== null);

if (scenesWithBaseline.length === 0) {
    test.skip("No baseline data — run scripts/snapshot-bundle-baseline.ts first", () => {});
} else {
    for (const scene of scenesWithBaseline) {
        const base = baselineForScene(scene.id)!;

        test(`${scene.name} bundle delta ≤ ${DELTA_PCT}% vs baseline (raw: ${base.rawKB} KB, gzip: ${base.gzipKB} KB)`, async ({ page }) => {
            const jsPayloads: { url: string; body: Buffer }[] = [];

            page.on("response", async (resp) => {
                const url = resp.url();
                if (url.includes("/bundle/") && url.endsWith(".js") && resp.ok()) {
                    const body = await resp.body();
                    jsPayloads.push({ url, body });
                }
            });

            await page.goto(`/bundle-scene${scene.id}.html`);
            await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });

            let totalRaw = 0;
            let totalGzip = 0;
            for (const { body } of jsPayloads) {
                totalRaw += body.length / 1024;
                totalGzip += gzipSync(body, { level: 9 }).length / 1024;
            }

            const rawKB = Math.round(totalRaw * 10) / 10;
            const gzipKB = Math.round(totalGzip * 10) / 10;

            const rawDeltaPct = base.rawKB > 0 ? ((rawKB - base.rawKB) / base.rawKB) * 100 : 0;
            const gzipDeltaPct = base.gzipKB > 0 ? ((gzipKB - base.gzipKB) / base.gzipKB) * 100 : 0;

            console.log(
                `  ${scene.name}: raw ${rawKB} KB (baseline: ${base.rawKB} KB, delta: ${rawDeltaPct > 0 ? "+" : ""}${rawDeltaPct.toFixed(1)}%) ` +
                    `gzip ${gzipKB} KB (baseline: ${base.gzipKB} KB, delta: ${gzipDeltaPct > 0 ? "+" : ""}${gzipDeltaPct.toFixed(1)}%)`
            );

            expect(rawDeltaPct, `raw bundle grew ${rawDeltaPct.toFixed(1)}% vs baseline (${base.rawKB} → ${rawKB} KB), limit: +${DELTA_PCT}%`).toBeLessThanOrEqual(DELTA_PCT);
        });
    }
}
