/**
 * GL lab Perf Regression — lite-gl (current) vs Babylon ThinEngine (baseline)
 *
 * The lite perf-regression spec (tests/lite/perf/perf-regression.spec.ts)
 * compares the CURRENT Lite bundle against a prior STABLE Lite baseline. Lite GL
 * has no prior stable baseline, so the natural baseline is the Babylon.js
 * ThinEngine reference page — the engine lite-gl replaces. This spec therefore
 * reports, per scene:
 *
 *   current  = the @babylonjs/lite-gl scene   (lab/gl/scene{N}.html)
 *   baseline = the Babylon ThinEngine ref      (lab/gl/babylon-ref-scene{N}.html)
 *
 * Measurement reuses the SAME RAF-callback timing approach as the GL RAF perf
 * benchmark (tests/gl/perf/gl-perf-raf.spec.ts): it instruments
 * requestAnimationFrame, warms up, then times the live animated render loop.
 * It deliberately does NOT use ?seekTime — the freeze convention halts the loop
 * after one frame (good for a stable parity screenshot, useless for sampling
 * per-frame cost). lite-gl is expected to be FASTER than Babylon here, so the
 * check has large headroom. The manifest populates the dashboard's "Perf
 * Regression" tab AND the spec gates: each scene asserts lite-gl stays within
 * REGRESSION_PCT of the Babylon baseline (sub-millisecond baselines are too noisy
 * to gate, so those are reported only). The manifest is written BEFORE the
 * assertion so the lab tab still updates when a scene regresses.
 *
 * Writes lab/public/gl/perf-regression-manifest.json (RegressionManifest shape,
 * matching the lite spec so the lab's renderPerfRegGrid() consumes it unchanged).
 *
 * Run:  npx playwright test --config playwright.perf.gl.config.ts tests/gl/perf/gl-perf-regression.spec.ts
 *   or: pnpm test:perf-regression:gl
 *
 * Env:  PERF_SCENES=4,6      — run only specific scenes (default: all non-skipPerf)
 *       PERF_DURATION=5      — measurement duration in seconds (default: 5)
 *       PERF_REGRESSION_PCT=5 — allowed % regression vs baseline (default: 5)
 */
import { test, expect } from "@playwright/test";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { BrowserContext } from "@playwright/test";

// ── Configuration ──────────────────────────────────────────────────

const DURATION_SEC = Number(process.env.PERF_DURATION) || 5;
const DURATION_MS = DURATION_SEC * 1000;
const WARMUP_MS = 2000;
// Same default allowed regression the lite spec uses (PERF_REGRESSION_PCT || 5).
const REGRESSION_PCT = Number(process.env.PERF_REGRESSION_PCT) || 5;
// Baselines below this (ms) are too small to gate reliably — especially under CI
// software rendering — so those scenes are reported but not asserted.
const NOISE_FLOOR_MS = 0.05;

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

const MANIFEST_PATH = resolve(__dirname, "../../../lab/public/gl/perf-regression-manifest.json");

// ── RAF instrumentation (injected before page scripts) ─────────────
// Identical to gl-perf-raf.spec.ts: time each RAF callback while measuring.

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
// PerfResult mirrors tests/lite/perf/perf-regression.spec.ts exactly so the
// dashboard's renderPerfRegGrid() reads current/baseline fields unchanged.

interface PerfResult {
    avgMs: number;
    p95Ms: number;
    medianMs: number;
    frameCount: number;
}

interface RegressionEntry {
    id: number;
    name: string;
    current: PerfResult;
    baseline: PerfResult;
    avgDeltaPct: number;
    p95DeltaPct: number;
    medianDeltaPct: number;
    /** current avg ≤ baseline avg * (1 + REGRESSION_PCT/100). Asserted per scene
     *  when baseline ≥ NOISE_FLOOR_MS (see the per-scene gate below). */
    pass: boolean;
}

interface RegressionManifest {
    generatedAt: string;
    regressionPct: number;
    /** RAF sampling window per measurement (seconds). The GL analogue of the
     *  lite spec's frameCount/runsPerScene frame-stepping knobs. */
    durationSec: number;
    /** baseline = Babylon ThinEngine reference (the engine lite-gl replaces). */
    baselineSource: string;
    scenes: Record<string, RegressionEntry>;
}

const MAX_RETRIES = 2;

// ── Helpers (mirrored from gl-perf-raf.spec.ts) ────────────────────

function round3(v: number): number {
    return Math.round(v * 1000) / 1000;
}

/** Load a page to warm the browser HTTP cache, then discard. */
async function warmupCache(context: BrowserContext, url: string): Promise<void> {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (document.querySelector("canvas") as HTMLCanvasElement)?.dataset.ready === "true", { timeout: 30_000 });
    await page.close();
}

function computeResult(timings: number[]): PerfResult {
    if (timings.length === 0) {
        return { avgMs: 0, p95Ms: 0, medianMs: 0, frameCount: 0 };
    }
    const sorted = [...timings].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    const avg = sum / sorted.length;
    return {
        avgMs: round3(avg),
        p95Ms: round3(sorted[Math.floor(sorted.length * 0.95)]!),
        medianMs: round3(sorted[Math.floor(sorted.length / 2)]!),
        frameCount: sorted.length,
    };
}

async function measurePage(context: BrowserContext, url: string, durationMs: number): Promise<PerfResult> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const result = await measurePageOnce(context, url, durationMs);
        if (result.frameCount > 0) {
            return result;
        }
        // RAF hook failed to capture frames — retry on a fresh page.
    }
    // Final attempt — return whatever we get.
    return measurePageOnce(context, url, durationMs);
}

async function measurePageOnce(context: BrowserContext, url: string, durationMs: number): Promise<PerfResult> {
    const page = await context.newPage();
    await page.addInitScript({ content: RAF_INIT_SCRIPT });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (document.querySelector("canvas") as HTMLCanvasElement)?.dataset.ready === "true", { timeout: 30_000 });

    // Warmup — let GPU caches / pipeline compilation settle.
    await page.waitForTimeout(WARMUP_MS);

    // Collect RAF timings over the live animated loop.
    await page.evaluate(() => {
        (window as { __rafTimings?: number[]; __rafMeasuring?: boolean }).__rafTimings = [];
        (window as { __rafTimings?: number[]; __rafMeasuring?: boolean }).__rafMeasuring = true;
    });
    await page.waitForTimeout(durationMs);

    const timings: number[] = await page.evaluate(() => {
        const w = window as { __rafTimings?: number[]; __rafMeasuring?: boolean };
        w.__rafMeasuring = false;
        return w.__rafTimings ?? [];
    });

    await page.close();
    return computeResult(timings);
}

function deltaPct(current: number, baseline: number): number {
    return baseline > 0 ? round3(((current - baseline) / baseline) * 100) : 0;
}

// ── Collect results across tests ───────────────────────────────────

const manifest: RegressionManifest = {
    generatedAt: new Date().toISOString(),
    regressionPct: REGRESSION_PCT,
    durationSec: DURATION_SEC,
    baselineSource: "babylon-thinengine-ref",
    scenes: {},
};

function persistManifest(): void {
    mkdirSync(resolve(MANIFEST_PATH, ".."), { recursive: true });
    // Merge with existing on disk so concurrent/recycled workers don't clobber
    // each other's scenes (mirrors the lite perf-regression spec).
    let merged: RegressionManifest = manifest;
    if (existsSync(MANIFEST_PATH)) {
        try {
            const prior = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as RegressionManifest;
            if (prior && prior.scenes) {
                merged = { ...manifest, scenes: { ...prior.scenes, ...manifest.scenes } };
            }
        } catch {
            // ignore corrupt prior manifest
        }
    }
    writeFileSync(MANIFEST_PATH, JSON.stringify(merged, null, 2) + "\n");
}

// ── Tests ──────────────────────────────────────────────────────────

test.describe("GL Perf Regression (lite-gl vs Babylon ref)", () => {
    test.afterAll(() => {
        if (Object.keys(manifest.scenes).length === 0) return;
        persistManifest();
        console.log(`\n\u2713 Wrote gl/perf-regression-manifest.json (${Object.keys(manifest.scenes).length} scenes)`);
        console.log(`  ${MANIFEST_PATH}`);
    });

    for (const scene of SCENES) {
        test(`${scene.label}`, async ({ browser }) => {
            const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

            const currentUrl = `/gl/scene${scene.id}.html`;
            const baselineUrl = `/gl/babylon-ref-scene${scene.id}.html`;

            try {
                // Pre-warm HTTP cache so neither engine pays first-load latency the other avoids.
                await warmupCache(context, baselineUrl);
                await warmupCache(context, currentUrl);

                // Measure baseline (Babylon ref) first, then current (lite-gl).
                const baseline = await measurePage(context, baselineUrl, DURATION_MS);
                const current = await measurePage(context, currentUrl, DURATION_MS);

                const avgDeltaPct = deltaPct(current.avgMs, baseline.avgMs);
                const p95DeltaPct = deltaPct(current.p95Ms, baseline.p95Ms);
                const medianDeltaPct = deltaPct(current.medianMs, baseline.medianMs);
                const limitMs = baseline.avgMs * (1 + REGRESSION_PCT / 100);
                const pass = baseline.avgMs < NOISE_FLOOR_MS || current.avgMs <= limitMs;

                manifest.scenes[scene.name] = {
                    id: scene.id,
                    name: scene.label,
                    current,
                    baseline,
                    avgDeltaPct,
                    p95DeltaPct,
                    medianDeltaPct,
                    pass,
                };

                // Write the manifest BEFORE asserting so the lab's Perf-Regression
                // tab updates even for a scene that fails the gate below.
                persistManifest();

                const ratio = current.avgMs > 0 && baseline.avgMs > 0 ? (baseline.avgMs / current.avgMs).toFixed(1) + "x" : "-";
                console.log(
                    `  ${scene.name} (${scene.label}): ` +
                        `current ${current.avgMs}ms / baseline ${baseline.avgMs}ms (${ratio} faster) | ` +
                        `delta ${avgDeltaPct > 0 ? "+" : ""}${avgDeltaPct.toFixed(1)}% | ` +
                        `p95 ${current.p95Ms}ms / ${baseline.p95Ms}ms | ` +
                        `median ${current.medianMs}ms / ${baseline.medianMs}ms | ` +
                        `${pass ? "PASS" : "SLOWER THAN BABYLON"}`
                );

                // Gate: lite-gl must not be materially slower than the Babylon
                // ThinEngine it replaces. Skip sub-noise-floor baselines (timings too
                // small to compare reliably, especially under CI software rendering).
                if (baseline.avgMs >= NOISE_FLOOR_MS) {
                    expect(
                        current.avgMs,
                        `${scene.label}: lite-gl ${current.avgMs}ms must stay ≤ Babylon ${baseline.avgMs}ms + ${REGRESSION_PCT}% (${limitMs.toFixed(3)}ms)`
                    ).toBeLessThanOrEqual(limitMs);
                }
            } finally {
                await context.close();
            }
        });
    }
});
