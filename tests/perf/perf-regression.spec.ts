/**
 * Performance Regression Test — Current Lite vs Stable
 *
 * Measures CPU + GPU frame time by intercepting the engine's RAF-based
 * render loop at runtime. No scene modifications required — hooks are
 * injected via Playwright's addInitScript:
 *
 *   1. Monkey-patches requestAnimationFrame to capture the render callback
 *   2. Monkey-patches GPUQueue.prototype.submit to capture the GPU queue
 *   3. Exposes window.__perfStop() to halt the RAF loop
 *   4. Exposes window.__perfRender() that calls the captured render fn
 *      then awaits device.queue.onSubmittedWorkDone() for GPU completion
 *
 * This gives true end-to-end per-frame cost (CPU + GPU) free from
 * vsync jitter and RAF scheduling noise.
 *
 * Prerequisites:
 *   pnpm build:bundle-scenes          — builds current bundles
 *   pnpm build:perf-baseline          — builds baseline bundles from last release
 *
 * Env:  PERF_REGRESSION_PCT=5   — allowed % regression (default: 5)
 *       PERF_FRAMES=300          — frames to render per measurement run (default: 300)
 *       PERF_RUNS=5              — measurement runs per version, takes median (default: 6)
 *       PERF_WARMUP=60            — warmup frames per run before measurement (default: 60)
 *       PERF_SCENES=1,5,9        — run only specific scenes (default: all)
 *
 * Run:  npx playwright test --config playwright.perf.config.ts tests/perf/perf-regression.spec.ts
 */
import { test, expect } from "@playwright/test";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { BrowserContext, Page } from "@playwright/test";

// ── Configuration ──────────────────────────────────────────────────

const REGRESSION_PCT = Number(process.env.PERF_REGRESSION_PCT) || 5;
const FRAME_COUNT = Number(process.env.PERF_FRAMES) || 800;
const WARMUP_FRAMES = Number(process.env.PERF_WARMUP) || 60;

interface SceneConfigEntry {
    id: number;
    slug: string;
    name: string;
    skipPerf?: boolean;
}

interface PerfResult {
    avgMs: number;
    p95Ms: number;
    medianMs: number;
    frameCount: number;
}

const CONFIG_PATH = resolve(__dirname, "../../scene-config.json");
const allScenes: SceneConfigEntry[] = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

const SELECTED = process.env.PERF_SCENES ? process.env.PERF_SCENES.split(",").map((s) => Number(s.trim())) : null;
const SCENES = (SELECTED ? allScenes.filter((s) => SELECTED.includes(s.id)) : allScenes).filter((s) => !s.skipPerf);

// Check if baseline bundles exist
const BASELINE_DIR = resolve(__dirname, "../../lab/public/bundle-baseline");
const hasBaseline = existsSync(BASELINE_DIR);

const RUNS_PER_SCENE = Number(process.env.PERF_RUNS) || 6;

// ── Runtime injection script ──────────────────────────────────────
// Injected before any page JS runs. Captures the engine's render
// callback and GPU queue without requiring changes to scene code.

const PERF_INIT_SCRIPT = `
(function() {
  var capturedRenderFn = null;
  var capturedQueue = null;
  var stopped = false;

  // Capture the GPU queue from any submit call
  var origSubmit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function() {
    capturedQueue = this;
    return origSubmit.apply(this, arguments);
  };

  // Capture the render callback from RAF and allow stopping the loop
  var origRAF = window.requestAnimationFrame.bind(window);
  var origCAF = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = function(cb) {
    capturedRenderFn = cb;
    if (stopped) return -1;
    return origRAF(cb);
  };

  // Stop the RAF loop — next RAF call returns -1
  window.__perfStop = function() {
    stopped = true;
  };

  // Render one frame: call the captured callback, then wait for GPU
  window.__perfRender = async function() {
    if (!capturedRenderFn) throw new Error("No render callback captured");
    capturedRenderFn(performance.now());
    if (capturedQueue) {
      await capturedQueue.onSubmittedWorkDone();
    }
  };

  // Signal that hooks are installed
  window.__perfReady = true;
})();
`;

// ── Helpers ────────────────────────────────────────────────────────

function round3(v: number): number {
    return Math.round(v * 1000) / 1000;
}

/**
 * Load a page with perf hooks injected, wait for ready, stop the RAF loop.
 *
 * Retries up to PAGE_LOAD_RETRIES times on transient CDP socket-idle errors
 * (common during WebGPU shader compilation in CI/SwiftShader environments).
 */
const PAGE_LOAD_RETRIES = 3;

async function preparePage(context: BrowserContext, url: string): Promise<Page> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= PAGE_LOAD_RETRIES; attempt++) {
        const page = await context.newPage();
        try {
            await page.addInitScript({ content: PERF_INIT_SCRIPT });
            await page.goto(url, { waitUntil: "domcontentloaded" });
            await page.waitForFunction(() => (document.querySelector("canvas") as HTMLCanvasElement)?.dataset.ready === "true", { timeout: 60_000 });

            // Stop the RAF loop so we control frame timing
            await page.evaluate(() => (window as any).__perfStop());

            return page;
        } catch (e) {
            lastError = e as Error;
            console.warn(`preparePage attempt ${attempt}/${PAGE_LOAD_RETRIES} failed for ${url}: ${lastError.message}`);
            await page.close().catch(() => {});
        }
    }

    throw lastError!;
}

/**
 * Run all measurement runs on a single page (one model load).
 * Each run = warmup + FRAME_COUNT measured frames.
 * Returns the median result across runs.
 *
 * Each run is a separate page.evaluate() call so the CDP WebSocket
 * gets a chance to respond to keepalive pings between runs, avoiding
 * "Socket idle from a long time" errors on BrowserStack.
 */
async function measurePage(context: BrowserContext, url: string, runs: number): Promise<PerfResult> {
    const page = await preparePage(context, url);

    const allResults: PerfResult[] = [];

    for (let r = 0; r < runs; r++) {
        const result: PerfResult | null = await page.evaluate(
            async ({ warmup, count }) => {
                const render = (window as any).__perfRender as () => Promise<void>;
                if (!render) throw new Error("__perfRender not found on window");

                function trimmedMean(values: number[]): number {
                    if (values.length === 0) return 0;
                    const sorted = [...values].sort((a: number, b: number) => a - b);
                    const trimCount = Math.floor(sorted.length * 0.1);
                    const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
                    if (trimmed.length === 0) return sorted[Math.floor(sorted.length / 2)]!;
                    return trimmed.reduce((s: number, v: number) => s + v, 0) / trimmed.length;
                }

                // Warmup for this run
                for (let i = 0; i < warmup; i++) {
                    await render();
                }

                // Measured frames
                const times: number[] = [];
                for (let i = 0; i < count; i++) {
                    const t0 = performance.now();
                    await render();
                    const t1 = performance.now();
                    times.push(t1 - t0);
                }

                if (times.length === 0) return null;

                const sorted = [...times].sort((a: number, b: number) => a - b);
                return {
                    avgMs: trimmedMean(times),
                    p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
                    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
                    frameCount: times.length,
                };
            },
            { warmup: WARMUP_FRAMES, count: FRAME_COUNT }
        );

        if (result) allResults.push(result);
    }

    await page.close();

    if (allResults.length === 0) return { avgMs: 0, p95Ms: 0, medianMs: 0, frameCount: 0 };
    allResults.sort((a, b) => a.avgMs - b.avgMs);
    const median = allResults[Math.floor(allResults.length / 2)]!;
    return {
        avgMs: round3(median.avgMs),
        p95Ms: round3(median.p95Ms),
        medianMs: round3(median.medianMs),
        frameCount: median.frameCount,
    };
}

// ── Tests ──────────────────────────────────────────────────────────

if (!hasBaseline) {
    test.skip("No baseline bundles — run `pnpm build:perf-baseline` first", () => {});
} else {
    test.describe("Performance: Current vs Stable", () => {
        for (const scene of SCENES) {
            test(`${scene.name} — current ≤ ${REGRESSION_PCT}% slower than baseline`, async ({ browser }) => {
                // New scenes added in a PR won't have a baseline bundle — skip gracefully
                const baselineHtml = resolve(__dirname, `../../lab/bundle-baseline-scene${scene.id}.html`);
                if (!existsSync(baselineHtml)) {
                    test.skip();
                    return;
                }

                const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

                const currentUrl = `/bundle-scene${scene.id}.html`;
                const baselineUrl = `/bundle-baseline-scene${scene.id}.html`;

                let baseline: PerfResult;
                let current: PerfResult;

                try {
                    // Measure baseline first (conservative: gives baseline more warm-up)
                    baseline = await measurePage(context, baselineUrl, RUNS_PER_SCENE);
                } catch (e) {
                    await context.close();
                    throw new Error(`[NOT A PERFORMANCE ISSUE] Baseline scene failed to load/render: ${(e as Error).message}`, { cause: e });
                }

                try {
                    current = await measurePage(context, currentUrl, RUNS_PER_SCENE);
                } catch (e) {
                    await context.close();
                    throw new Error(`[NOT A PERFORMANCE ISSUE] Current scene failed to load/render: ${(e as Error).message}`, { cause: e });
                }

                await context.close();

                const avgDeltaPct = baseline.avgMs > 0 ? ((current.avgMs - baseline.avgMs) / baseline.avgMs) * 100 : 0;
                const p95DeltaPct = baseline.p95Ms > 0 ? ((current.p95Ms - baseline.p95Ms) / baseline.p95Ms) * 100 : 0;

                console.log(
                    `  ${scene.name}: ` +
                        `current ${current.avgMs}ms / baseline ${baseline.avgMs}ms | ` +
                        `delta: ${avgDeltaPct > 0 ? "+" : ""}${avgDeltaPct.toFixed(1)}% | ` +
                        `p95: ${current.p95Ms}ms / ${baseline.p95Ms}ms (${p95DeltaPct > 0 ? "+" : ""}${p95DeltaPct.toFixed(1)}%) | ` +
                        `median: ${current.medianMs}ms / ${baseline.medianMs}ms`
                );

                // Only assert on trimmed mean — p95 is too noisy at sub-ms frame times
                // (a single GC pause creates 30%+ swings). p95 is still logged for visibility.
                expect(
                    avgDeltaPct,
                    `Avg ${current.avgMs}ms vs baseline ${baseline.avgMs}ms (+${avgDeltaPct.toFixed(1)}%, limit: +${REGRESSION_PCT}%) | p95: ${current.p95Ms}ms vs ${baseline.p95Ms}ms (+${p95DeltaPct.toFixed(1)}%) | median: ${current.medianMs}ms vs ${baseline.medianMs}ms`
                ).toBeLessThanOrEqual(REGRESSION_PCT);
            });
        }
    });
}
