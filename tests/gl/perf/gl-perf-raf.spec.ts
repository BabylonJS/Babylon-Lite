/**
 * GL lab RAF Performance Benchmark
 *
 * Measures per-frame requestAnimationFrame callback duration for the
 * @babylonjs/lite-gl GL lab scenes vs their Babylon.js ThinEngine references.
 * Writes results to lab/public/gl/perf-manifest.json which the GL dashboard
 * Perf tab consumes. This is the GL sibling of tests/lite/perf/perf-raf.spec.ts.
 *
 * Run:  npx playwright test --config playwright.perf.gl.config.ts
 *   or: pnpm test:perf:gl
 *
 * Env:  PERF_SCENES=1,2   — run only specific scenes (default: all non-skipPerf)
 *       PERF_DURATION=5   — measurement duration in seconds (default: 5)
 *
 * Config-driven: scenes are read from scene-config-webgl.json and any entry
 * flagged `skipPerf` is excluded, so enabling scenes 2-6 later is just flipping
 * the flag (and authoring their reference page).
 *
 * Perf does NOT use ?seekTime — it deliberately measures the live animated loop.
 *
 * NOTE: Measures CPU-side time only (JS execution + command encoding + GL
 * submission). GPU execution is async and not captured.
 */
import { test } from "@playwright/test";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { BrowserContext } from "@playwright/test";

// ── Configuration ──────────────────────────────────────────────────

const DURATION_SEC = Number(process.env.PERF_DURATION) || 5;
const DURATION_MS = DURATION_SEC * 1000;
const WARMUP_MS = 2000;

interface SceneDef {
    /** Manifest key + URL stem, e.g. "scene1". */
    name: string;
    /** Numeric scene id from scene-config-webgl.json. */
    id: number;
    /** Human-readable label. */
    label: string;
}

interface SceneConfigEntry {
    id: number;
    slug: string;
    name: string;
    skipPerf?: boolean;
}

const SCENE_CONFIG: SceneConfigEntry[] = JSON.parse(readFileSync(resolve(__dirname, "../../../scene-config-webgl.json"), "utf-8"));

const ALL_SCENES: SceneDef[] = SCENE_CONFIG.filter((entry) => !entry.skipPerf).map((entry) => ({
    name: `scene${entry.id}`,
    id: entry.id,
    label: entry.name,
}));

const SELECTED = process.env.PERF_SCENES ? process.env.PERF_SCENES.split(",").map((s) => `scene${s.trim()}`) : null;

const SCENES = SELECTED ? ALL_SCENES.filter((s) => SELECTED.includes(s.name)) : ALL_SCENES;

const MANIFEST_PATH = resolve(__dirname, "../../../lab/public/gl/perf-manifest.json");

// ── RAF instrumentation (injected before page scripts) ─────────────

const RAF_INIT_SCRIPT = `
  var __origRAF = window.requestAnimationFrame.bind(window);
  window.__rafTimings = [];
  window.__rafMeasuring = false;
  window.requestAnimationFrame = function(cb) {
    return __origRAF(function(ts) {
      if (window.__rafMeasuring) {
        var t0 = performance.now();
        cb(ts);
        var t1 = performance.now();
        window.__rafTimings.push(t1 - t0);
      } else {
        cb(ts);
      }
    });
  };
`;

// ── Types ──────────────────────────────────────────────────────────

interface SceneStats {
    fps: number;
    initTime: number;
    drawCalls: number;
    rafAvgMs: number;
    rafMedianMs: number;
    rafP95Ms: number;
    rafP99Ms: number;
    frames: number;
    memoryMB: number;
}

const MAX_RETRIES = 2;

interface SceneResult {
    lite: SceneStats;
    bjs: SceneStats;
}

type Manifest = Record<string, SceneResult>;

// ── Helpers ────────────────────────────────────────────────────────

/** Load a page to warm the browser HTTP cache, then discard. */
async function warmupCache(context: BrowserContext, url: string): Promise<void> {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (document.querySelector("canvas") as HTMLCanvasElement)?.dataset.ready === "true", { timeout: 30_000 });
    await page.close();
}

function computeStats(timings: number[], durationMs: number): Omit<SceneStats, "initTime" | "drawCalls"> {
    if (timings.length === 0) {
        return { fps: 0, rafAvgMs: 0, rafMedianMs: 0, rafP95Ms: 0, rafP99Ms: 0, frames: 0, memoryMB: 0 };
    }
    const sorted = [...timings].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    const avg = sum / sorted.length;
    const fps = Math.round((sorted.length / durationMs) * 1000 * 10) / 10;

    return {
        fps,
        rafAvgMs: round3(avg),
        rafMedianMs: round3(sorted[Math.floor(sorted.length / 2)]!),
        rafP95Ms: round3(sorted[Math.floor(sorted.length * 0.95)]!),
        rafP99Ms: round3(sorted[Math.floor(sorted.length * 0.99)]!),
        frames: sorted.length,
        memoryMB: 0,
    };
}

function round3(v: number): number {
    return Math.round(v * 1000) / 1000;
}

async function measurePage(context: BrowserContext, url: string, durationMs: number): Promise<SceneStats> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const result = await measurePageOnce(context, url, durationMs);
        if (result.fps > 0) {
            return result;
        }
        // RAF hook failed — retry on a fresh page
    }
    // Final attempt — return whatever we get
    return measurePageOnce(context, url, durationMs);
}

async function measurePageOnce(context: BrowserContext, url: string, durationMs: number): Promise<SceneStats> {
    const page = await context.newPage();
    await page.addInitScript({ content: RAF_INIT_SCRIPT });

    await page.goto(url, { waitUntil: "domcontentloaded" });

    await page.waitForFunction(() => (document.querySelector("canvas") as HTMLCanvasElement)?.dataset.ready === "true", { timeout: 30_000 });

    // Read init time (pages stamp delta from function start to first frame)
    const initMs = await page.evaluate(() => {
        return parseFloat((document.querySelector("canvas") as HTMLCanvasElement).dataset.initMs || "0");
    });

    // Warmup — let GPU caches / pipeline compilation settle
    await page.waitForTimeout(WARMUP_MS);

    // Read draw calls after warmup
    const drawCalls = await page.evaluate(() => {
        return parseInt((document.querySelector("canvas") as HTMLCanvasElement).dataset.drawCalls || "0", 10);
    });

    // Collect RAF timings
    await page.evaluate(() => {
        (window as any).__rafTimings = [];
        (window as any).__rafMeasuring = true;
    });
    await page.waitForTimeout(durationMs);

    const timings: number[] = await page.evaluate(() => {
        const w = window as any;
        w.__rafMeasuring = false;
        return w.__rafTimings as number[];
    });

    // Measure JS heap memory (Chrome-only, requires --enable-precise-memory-info)
    const memoryBytes: number = await page.evaluate(() => {
        const mem = (performance as any).memory;
        return mem ? mem.usedJSHeapSize : 0;
    });
    const memoryMB = round3(memoryBytes / (1024 * 1024));

    await page.close();

    const stats = computeStats(timings, durationMs);
    return {
        ...stats,
        initTime: Math.round(initMs) / 1000,
        drawCalls,
        memoryMB,
    };
}

// ── Collect results across tests ───────────────────────────────────

function loadExistingManifest(): Manifest {
    try {
        if (existsSync(MANIFEST_PATH)) {
            return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
        }
    } catch {
        // Corrupted or missing — start fresh
    }
    return {};
}

const manifest: Manifest = loadExistingManifest();

// ── Tests ──────────────────────────────────────────────────────────

test.describe("GL RAF Performance Benchmark", () => {
    for (const scene of SCENES) {
        test(`${scene.label}`, async ({ browser }) => {
            const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

            const liteUrl = `/gl/scene${scene.id}.html`;
            const bjsUrl = `/gl/babylon-ref-scene${scene.id}.html`;

            // Pre-warm HTTP cache so neither engine pays first-load latency the other avoids.
            await warmupCache(context, liteUrl);
            await warmupCache(context, bjsUrl);

            const lite = await measurePage(context, liteUrl, DURATION_MS);
            const bjs = await measurePage(context, bjsUrl, DURATION_MS);

            await context.close();

            manifest[scene.name] = { lite, bjs };

            // Write incrementally so partial runs are persisted
            mkdirSync(resolve(MANIFEST_PATH, ".."), { recursive: true });
            writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

            // Log results
            const rafRatio = bjs.rafAvgMs > 0 && lite.rafAvgMs > 0 ? (bjs.rafAvgMs / lite.rafAvgMs).toFixed(1) + "x" : "-";
            console.log(
                `  ${scene.label}: ` +
                    `RAF ${lite.rafAvgMs}ms / ${bjs.rafAvgMs}ms (${rafRatio}) | ` +
                    `FPS ${lite.fps} / ${bjs.fps} | ` +
                    `Init ${lite.initTime}s / ${bjs.initTime}s | ` +
                    `Draw ${lite.drawCalls} / ${bjs.drawCalls} | ` +
                    `Mem ${lite.memoryMB}MB / ${bjs.memoryMB}MB`
            );
        });
    }

    test.afterAll(() => {
        if (Object.keys(manifest).length === 0) return;

        mkdirSync(resolve(MANIFEST_PATH, ".."), { recursive: true });
        writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
        console.log(`\n✓ Wrote gl/perf-manifest.json (${Object.keys(manifest).length} scenes)`);
        console.log(`  ${MANIFEST_PATH}`);
    });
});
