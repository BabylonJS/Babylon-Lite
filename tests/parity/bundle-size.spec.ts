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

interface BundleInfoModule {
    id: string;
}

interface BundleInfoChunk {
    file: string;
    modules: BundleInfoModule[];
}

function getRuntimeModuleIds(sceneKey: string, runtimeFiles: readonly string[]): string[] {
    const info = JSON.parse(readFileSync(resolve(BUNDLE_INFO_DIR, `${sceneKey}.json`), "utf-8")) as { chunks: BundleInfoChunk[] };
    const loaded = new Set(runtimeFiles);
    return info.chunks.filter((chunk) => loaded.has(chunk.file)).flatMap((chunk) => chunk.modules.map((module) => module.id.replace(/\\/g, "/")));
}

interface BundleManifestEntry {
    rawKB?: number;
    ignoredRawKB?: number;
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
        const sceneKey = `scene${scene.id}`;
        const masterEntry = MASTER_MANIFEST?.[sceneKey];
        const ignoredRawKB = masterEntry?.ignoredRawKB ?? summary.ignoredRawBytes / 1024;
        const rawKB = masterEntry?.ignoredRawKB != null ? Math.max(0, summary.fetchedRawBytes / 1024 - masterEntry.ignoredRawKB) : summary.rawBytes / 1024;
        const gzipKB = summary.gzipBytes / 1024;

        console.log(`  ${scene.name}: ${rawKB.toFixed(1)} KB raw (limit: ${scene.maxRawKB} KB), ${gzipKB.toFixed(1)} KB gzip (informational)`);
        const masterRawKB = masterEntry?.rawKB;
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

        const runtimeFiles = jsPayloads.map((p) => p.file);
        const runtimeModules = getRuntimeModuleIds(`scene${scene.id}`, runtimeFiles);

        expect(rawKB, `raw ${rawKB.toFixed(1)} KB exceeds ceiling ${scene.maxRawKB} KB (+${(rawKB - scene.maxRawKB!).toFixed(1)} KB over)`).toBeLessThanOrEqual(scene.maxRawKB!);

        // Pure-2D ceiling: scenes 50/51 must NOT pull any scene/* code, the depth-hosted
        // sprite renderable wrapper, handle modules, or scene-helpers (scene BGL etc.). Tree-shaking
        // currently strips these from the pure-2D path; a future edit that accidentally
        // pulls them in (e.g. a top-level reference to getSceneBindGroupLayout in
        // sprite-pipeline.ts) must trip this guard rather than silently regressing.
        if (scene.slug === "scene50-sprite-grid" || scene.slug === "scene51-sprite-grid") {
            const forbiddenChunks = /scene-core|scene-camera|scene-node|asset-container|scene-helpers|sprite-renderable|sprite-2d-handle|billboard-/;
            const chunkOffenders = jsPayloads.map((p) => p.url.split("/").pop()!).filter((f) => forbiddenChunks.test(f));
            expect(chunkOffenders, `pure-2D ${scene.slug} must not load scene/* chunks; found: ${chunkOffenders.join(", ")}`).toEqual([]);
            const forbiddenModules =
                /\/(scene\/scene-core|scene\/scene-camera|scene\/scene-node|asset-container|render\/scene-helpers|sprite\/sprite-renderable|sprite\/sprite-2d-handle|sprite\/billboard-(sprite|scene|renderable|pipeline|sprite-handle))\.ts$/;
            const moduleOffenders = runtimeModules.filter((id) => forbiddenModules.test(id));
            expect(moduleOffenders, `pure-2D ${scene.slug} must not load scene/* modules; found: ${moduleOffenders.join(", ")}`).toEqual([]);
        }

        // Scene 52 — HUD on 3D — uses SpriteRenderer for the HUD overlay; the
        // depth-hosted Renderable wrapper (sprite-renderable.js) must NOT be
        // pulled in. If it is, scene52 accidentally used the depth-hosted
        // addToScene path instead of the HUD SpriteRenderer path.
        if (scene.slug === "scene52-hud-on-3d") {
            const offenders = runtimeModules.filter((id) => /\/sprite\/(sprite-renderable|billboard-(sprite|scene|renderable|pipeline))\.ts$/.test(id));
            expect(offenders, `scene52 HUD must not load depth-hosted sprite modules; found: ${offenders.join(", ")}`).toEqual([]);
        }

        // Scene 53 — depth-hosted sprites — MUST load sprite-renderable.js
        // (proves the addToScene sprite admission path is active) and MUST load
        // scene-core (it is a real 3D scene, not pure-2D).
        if (scene.slug === "scene53-depth-hosted-sprites") {
            expect(
                runtimeModules.some((id) => /\/sprite\/sprite-renderable\.ts$/.test(id)),
                `scene53 depth-hosted MUST include sprite-renderable.ts; loaded modules: ${runtimeModules.join(", ")}`
            ).toBe(true);
        }

        if (
            scene.slug === "scene54-facing-billboards" ||
            scene.slug === "scene55-billboard-sorting" ||
            scene.slug === "scene56-axis-locked-billboards" ||
            scene.slug === "scene57-cutout-billboards"
        ) {
            expect(
                runtimeModules.some((id) => /\/sprite\/billboard-renderable\.ts$/.test(id)),
                `${scene.slug} MUST include billboard-renderable.ts; loaded modules: ${runtimeModules.join(", ")}`
            ).toBe(true);
        }

        // Mesh-only / non-sprite 3D scenes must NOT pull in any sprite code.
        // List excludes the sprite-using scenes (50, 51, 52, 53, 54, 55, 56, 57). 60-series are
        // NME demos with no sprites; 1-40 are core 3D.
        const SPRITE_USING_IDS = new Set([50, 51, 52, 53, 54, 55, 56, 57]);
        if (!SPRITE_USING_IDS.has(scene.id)) {
            const offenders = runtimeModules.filter((id) => /\/sprite\/.*\.ts$/.test(id));
            expect(offenders, `non-sprite ${scene.slug} must not load sprite modules; found: ${offenders.join(", ")}`).toEqual([]);
        }
    });
}
