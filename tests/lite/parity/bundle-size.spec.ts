/**
 * Bundle Size Regression Tests (Live)
 *
 * Loads each bundle-sceneN.html in a real browser via Playwright, intercepts
 * network responses, and measures only the JS bytes actually fetched at
 * runtime, minus (a) local *-nme.ts graph payload modules and (b) the
 * `text-shaper` shaping library (vendor dep that callers using their own
 * layout pay zero for). Dynamic-import chunks that are never loaded
 * (e.g. animation-group for a static model) are correctly excluded.
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
import { IGNORED_BUNDLE_MODULE_PATTERN, summarizeRuntimeBundle } from "../../../scripts/bundle-size-accounting";

const CONFIG_PATH = resolve(__dirname, "../../../scene-config.json");
const BUNDLE_INFO_DIR = resolve(__dirname, "../../../lab/public/bundle/bundle-info");
const BUNDLE_MANIFEST_PATH = resolve(__dirname, "../../../lab/public/bundle/manifest.json");
const MASTER_MANIFEST_PATH = resolve(__dirname, "../../../lab/public/bundle/master-manifest.json");
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
    runtimeChunks?: string[];
}

type BundleManifest = Record<string, BundleManifestEntry>;

function loadBundleManifest(path: string): BundleManifest | null {
    if (!existsSync(path)) {
        return null;
    }

    return JSON.parse(readFileSync(path, "utf-8")) as BundleManifest;
}

function roundedKB(value: number): number {
    return Math.round(value * 10) / 10;
}

const MASTER_MANIFEST = loadBundleManifest(MASTER_MANIFEST_PATH);
const BUNDLE_MANIFEST = loadBundleManifest(BUNDLE_MANIFEST_PATH);

for (const scene of SCENES) {
    test(`${scene.name} bundle ≤ ${scene.maxRawKB} KB raw`, async ({ page }) => {
        test.setTimeout(90_000);
        const jsPayloads: { url: string; file: string; body: Buffer }[] = [];
        const runtimeFiles: string[] = [];

        // Intercept every JS response served from /bundle/
        const onResponse = (resp: import("@playwright/test").Response): void => {
            const url = resp.url();
            if (url.includes("/bundle/") && url.endsWith(".js") && resp.ok()) {
                runtimeFiles.push(url.split("/").pop()!.split("?")[0]!);
            }
        };
        page.on("response", onResponse);

        // Navigate to the bundle page and wait for the scene to finish rendering
        await page.goto(`bundle-scene${scene.id}.html`, { waitUntil: "domcontentloaded" });
        let readyTimedOut = false;
        try {
            await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", undefined, { timeout: 20_000 });
        } catch {
            // Some heavy scenes fetch all runtime JS but do not mark the canvas ready in cloud browsers.
            readyTimedOut = true;
        }
        if (readyTimedOut) {
            page.off("response", onResponse);
            await page.close();
            const sceneKey = `scene${scene.id}`;
            const files = BUNDLE_MANIFEST?.[sceneKey]?.runtimeChunks;
            expect(files, `bundle manifest must contain runtime chunks for ${sceneKey}`).toBeTruthy();
            runtimeFiles.length = 0;
            runtimeFiles.push(...files!);
        } else {
            page.off("response", onResponse);
            await page.close();
        }
        for (const file of Array.from(new Set(runtimeFiles))) {
            jsPayloads.push({ url: `/bundle/${file}`, file, body: readFileSync(resolve(__dirname, "../../../lab/public/bundle", file)) });
        }

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
        // The ceiling check uses THIS build's own accounting (fetched runtime bytes minus
        // its own ignored modules — NME data + bundled vendor WASM/shaping runtimes). The
        // master manifest is used only for the advisory "increased vs master" delta below,
        // never to compute the gated rawKB (pinning ignored bytes to a source-built master
        // would mis-count a build/lib measurement's bundled vendor chunks).
        const ignoredRawKB = summary.ignoredRawBytes / 1024;
        const rawKB = summary.rawBytes / 1024;
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

        const loadedFiles = jsPayloads.map((p) => p.file);
        const runtimeModules = getRuntimeModuleIds(`scene${scene.id}`, loadedFiles);

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
                /\/(scene\/scene-core|scene\/scene-camera|scene\/scene-node|asset-container|render\/scene-helpers|sprite\/sprite-renderable|sprite\/sprite-2d-handle|sprite\/billboard-(sprite|scene|renderable|pipeline|sprite-handle))\.[jt]s$/;
            const moduleOffenders = runtimeModules.filter((id) => forbiddenModules.test(id));
            expect(moduleOffenders, `pure-2D ${scene.slug} must not load scene/* modules; found: ${moduleOffenders.join(", ")}`).toEqual([]);
        }

        // Scene 52 — HUD on 3D — uses SpriteRenderer for the HUD overlay; the
        // depth-hosted Renderable wrapper (sprite-renderable.js) must NOT be
        // pulled in. If it is, scene52 accidentally used the depth-hosted
        // addToScene path instead of the HUD SpriteRenderer path.
        if (scene.slug === "scene52-hud-on-3d") {
            const offenders = runtimeModules.filter((id) => /\/sprite\/(sprite-renderable|billboard-(sprite|scene|renderable|pipeline))\.[jt]s$/.test(id));
            expect(offenders, `scene52 HUD must not load depth-hosted sprite modules; found: ${offenders.join(", ")}`).toEqual([]);
        }

        // Scene 53 — depth-hosted sprites — MUST load sprite-renderable.js
        // (proves the addToScene sprite admission path is active) and MUST load
        // scene-core (it is a real 3D scene, not pure-2D).
        if (scene.slug === "scene53-depth-hosted-sprites") {
            expect(
                runtimeModules.some((id) => /\/sprite\/sprite-renderable\.[jt]s$/.test(id)),
                `scene53 depth-hosted MUST include sprite-renderable; loaded modules: ${runtimeModules.join(", ")}`
            ).toBe(true);
        }

        if (
            scene.slug === "scene54-facing-billboards" ||
            scene.slug === "scene55-billboard-sorting" ||
            scene.slug === "scene56-axis-locked-billboards" ||
            scene.slug === "scene57-cutout-billboards" ||
            scene.slug === "scene59-billboard-animation"
        ) {
            expect(
                runtimeModules.some((id) => /\/sprite\/billboard-renderable\.[jt]s$/.test(id)),
                `${scene.slug} MUST include billboard-renderable; loaded modules: ${runtimeModules.join(", ")}`
            ).toBe(true);
        }

        // Mesh-only / non-sprite 3D scenes must NOT pull in any sprite code.
        // List excludes the sprite-using scenes (50-59 and the 92-95 custom-shader scenes). 60-series are
        // NME demos with no sprites; 1-40 are core 3D.
        const SPRITE_USING_IDS = new Set([50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 92, 93, 94, 95, 96, 97, 98, 205, 206]);
        if (!SPRITE_USING_IDS.has(scene.id)) {
            const offenders = runtimeModules.filter((id) => /\/sprite\/.*\.[jt]s$/.test(id));
            expect(offenders, `non-sprite ${scene.slug} must not load sprite modules; found: ${offenders.join(", ")}`).toEqual([]);
        }
    });
}
