/**
 * Pixel comparison utilities for parity tests.
 * Compares screenshots from Babylon Lite against golden reference images.
 */
import { PNG } from "pngjs";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, TestInfo } from "@playwright/test";

export interface SceneConfig {
    id: number;
    slug: string;
    name: string;
    maxMad: number;
    maxRegionMad?: number;
    maxRawKB?: number;
    /** Optional human-readable caveat rendered on lab cards (e.g. temporarily relaxed ceilings). */
    note?: string;
    /** Skip this scene in parity tests. */
    skipParity?: boolean;
    /** Skip this scene in parity tests only when running in CI. */
    skipParityOnCI?: boolean;
    /** Skip this scene in perf tests. */
    skipPerf?: boolean;
}

let _sceneConfigCache: SceneConfig[] | null = null;

export function shouldSkipParity(sceneConfig: Pick<SceneConfig, "skipParity" | "skipParityOnCI">, env: { CI?: string } = process.env): boolean {
    return !!sceneConfig.skipParity || (!!sceneConfig.skipParityOnCI && !!env.CI);
}

function loadSceneConfigAll(): SceneConfig[] {
    if (!_sceneConfigCache) {
        const configPath = path.resolve(__dirname, "../../../scene-config.json");
        _sceneConfigCache = JSON.parse(fs.readFileSync(configPath, "utf-8")) as SceneConfig[];
    }
    return _sceneConfigCache;
}

/** Load the MAD threshold config for a scene by its ID. */
export function getSceneConfig(sceneId: number): SceneConfig {
    const all = loadSceneConfigAll();
    const entry = all.find((s) => s.id === sceneId);
    if (!entry) {
        throw new Error(`No scene-config.json entry for scene ${sceneId}`);
    }
    return {
        ...entry,
        skipParity: shouldSkipParity(entry) || undefined,
    };
}

export interface CompareResult {
    totalPixels: number;
    exactMatch: number;
    within1: number;
    within3: number;
    within5: number;
    mad: number; // mean absolute difference
    maxDiff: number;
}

export interface RegionResult extends CompareResult {
    regionPixels: number;
}

/** Parse a PNG file into {width, height, data: Uint8Array (RGBA)} */
function loadPng(path: string): { width: number; height: number; data: Uint8Array } {
    const buf = fs.readFileSync(path);
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

/** Compare two PNG files pixel-by-pixel. Returns stats for all pixels. */
export function compareImages(actualPath: string, referencePath: string): CompareResult {
    const actual = loadPng(actualPath);
    const ref = loadPng(referencePath);
    const w = Math.min(actual.width, ref.width);
    const h = Math.min(actual.height, ref.height);

    let exactMatch = 0,
        within1 = 0,
        within3 = 0,
        within5 = 0;
    let sumDiff = 0,
        maxDiff = 0;
    const total = w * h;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const ai = (y * actual.width + x) * 4;
            const ri = (y * ref.width + x) * 4;
            let pixMax = 0;
            let pixSum = 0;
            for (let c = 0; c < 3; c++) {
                const d = Math.abs(actual.data[ai + c]! - ref.data[ri + c]!);
                pixSum += d;
                if (d > pixMax) pixMax = d;
            }
            sumDiff += pixSum / 3;
            if (pixMax > maxDiff) maxDiff = pixMax;
            if (pixMax === 0) exactMatch++;
            if (pixMax <= 1) within1++;
            if (pixMax <= 3) within3++;
            if (pixMax <= 5) within5++;
        }
    }

    return {
        totalPixels: total,
        exactMatch,
        within1,
        within3,
        within5,
        mad: sumDiff / total,
        maxDiff,
    };
}

/**
 * Compare only a masked region (non-background pixels in the reference).
 * Background is defined as pixels within `threshold` Euclidean distance of `bgColor`.
 */
export function compareRegion(actualPath: string, referencePath: string, bgColor: [number, number, number] = [51, 51, 77], threshold = 30): RegionResult {
    const actual = loadPng(actualPath);
    const ref = loadPng(referencePath);
    const w = Math.min(actual.width, ref.width);
    const h = Math.min(actual.height, ref.height);

    let exactMatch = 0,
        within1 = 0,
        within3 = 0,
        within5 = 0;
    let sumDiff = 0,
        maxDiff = 0,
        regionPixels = 0;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const ri = (y * ref.width + x) * 4;
            // Check if reference pixel is background
            const dr = ref.data[ri]! - bgColor[0];
            const dg = ref.data[ri + 1]! - bgColor[1];
            const db = ref.data[ri + 2]! - bgColor[2];
            if (Math.sqrt(dr * dr + dg * dg + db * db) <= threshold) continue;

            regionPixels++;
            const ai = (y * actual.width + x) * 4;
            let pixMax = 0;
            let pixSum = 0;
            for (let c = 0; c < 3; c++) {
                const d = Math.abs(actual.data[ai + c]! - ref.data[ri + c]!);
                pixSum += d;
                if (d > pixMax) pixMax = d;
            }
            sumDiff += pixSum / 3;
            if (pixMax > maxDiff) maxDiff = pixMax;
            if (pixMax === 0) exactMatch++;
            if (pixMax <= 1) within1++;
            if (pixMax <= 3) within3++;
            if (pixMax <= 5) within5++;
        }
    }

    return {
        totalPixels: w * h,
        regionPixels,
        exactMatch,
        within1,
        within3,
        within5,
        mad: regionPixels > 0 ? sumDiff / regionPixels : 0,
        maxDiff,
    };
}

// ── Diff map generation ───────────────────────────────────────────

/**
 * Generate a visual diff map PNG highlighting per-pixel differences.
 * - Green channel = per-channel max diff (amplified 4×)
 * - Red channel = pixels exceeding threshold 5
 * - Blue channel = pixels exceeding threshold 1
 * Identical pixels are transparent black.
 */
export function generateDiffMap(actualPath: string, referencePath: string, outputPath: string): void {
    const actual = loadPng(actualPath);
    const ref = loadPng(referencePath);
    const w = Math.min(actual.width, ref.width);
    const h = Math.min(actual.height, ref.height);

    const diff = new PNG({ width: w, height: h });

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const ai = (y * actual.width + x) * 4;
            const ri = (y * ref.width + x) * 4;
            const di = (y * w + x) * 4;

            let pixMax = 0;
            for (let c = 0; c < 3; c++) {
                const d = Math.abs(actual.data[ai + c]! - ref.data[ri + c]!);
                if (d > pixMax) pixMax = d;
            }

            // Amplify differences for visibility
            const green = Math.min(255, pixMax * 4);
            const red = pixMax > 5 ? 255 : 0;
            const blue = pixMax > 1 ? 180 : 0;
            const alpha = pixMax > 0 ? 255 : 0;

            diff.data[di] = red;
            diff.data[di + 1] = green;
            diff.data[di + 2] = blue;
            diff.data[di + 3] = alpha;
        }
    }

    fs.writeFileSync(outputPath, PNG.sync.write(diff));
}

// ── Playwright report attachments ─────────────────────────────────

/**
 * Attach actual screenshot, golden reference, and diff map to the
 * Playwright HTML report. Call this after compareImages/compareRegion.
 */
export async function attachCompareArtifacts(testInfo: TestInfo, actualPath: string, goldenPath: string, refDir: string): Promise<void> {
    const diffPath = path.join(refDir, "diff-map.png");
    generateDiffMap(actualPath, goldenPath, diffPath);

    await testInfo.attach("actual", { path: actualPath, contentType: "image/png" });
    await testInfo.attach("reference", { path: goldenPath, contentType: "image/png" });
    await testInfo.attach("diff-map", { path: diffPath, contentType: "image/png" });
}

// ── Golden reference capture ──────────────────────────────────────

/**
 * Wait for `canvas.dataset[flag] === "true"`, polling from the Node side rather
 * than via a single long `page.waitForFunction`.
 *
 * On BrowserStack the automation connection is dropped ("Socket idle from a long
 * time") when no Playwright commands are sent while a heavy scene downloads
 * assets / compiles WebGPU pipelines — a single `waitForFunction` polls inside
 * the page and sends nothing over the wire for the whole wait. Polling with a
 * short `page.evaluate` every second keeps the connection active.
 *
 * Also fails fast (instead of timing out) when the scene sets
 * `canvas.dataset.error` in its top-level catch.
 */
export async function waitForCanvasReady(page: Page, opts: { timeout: number; label: string; flag?: string; pollMs?: number }): Promise<void> {
    const flag = opts.flag ?? "ready";
    const pollMs = opts.pollMs ?? 1000;
    const start = Date.now();
    for (;;) {
        const state = await page.evaluate((f) => {
            const c = document.querySelector("canvas") as HTMLCanvasElement | null;
            return { done: c?.dataset[f] === "true", error: c?.dataset.error ?? null };
        }, flag);
        if (state.error) {
            throw new Error(`${opts.label} failed to initialize: ${state.error}`);
        }
        if (state.done) {
            return;
        }
        if (Date.now() - start > opts.timeout) {
            throw new Error(`${opts.label}: timed out after ${opts.timeout}ms waiting for canvas.dataset.${flag} === "true"`);
        }
        await page.waitForTimeout(pollMs);
    }
}

export interface CaptureGoldenOptions {
    /** Scene ID number (e.g. 7 for scene7) */
    sceneId: number;
    /** Force recapture even when a golden already exists on disk. */
    force?: boolean;
    /** seekTime query param for animated scenes (omit for static) */
    seekTime?: number;
    /** Extra query string (without leading '?') appended to the ref page URL. */
    queryParams?: string;
    /**
     * Optional extra `canvas.dataset` flag to await (after `ready`) before screenshotting.
     * Used by the frame-capture physics scenes that signal `captureReady` once the page has
     * advanced to its requested `?captureFrame=N` and frozen. Polled like `waitForCanvasReady`.
     */
    waitFlag?: string;
    /** Page load timeout in ms (default: 60_000) */
    timeout?: number;
    /** GPU settle delay in ms (default: 1500) */
    settleMs?: number;
}

/**
 * Capture a fresh golden reference from the BJS reference page.
 * Opens babylon-ref-sceneN.html in a new page, waits for ready + animation freeze,
 * screenshots the canvas, and saves as babylon-ref-golden.png.
 *
 * Skips capture if the golden file already exists on disk (committed references).
 * Set RECAPTURE_GOLDEN=true or pass force=true to force recapture.
 *
 * Must be called with the Page's browser (page.context().browser()).
 */
export async function captureGolden(browser: Browser, opts: CaptureGoldenOptions): Promise<string> {
    const config = getSceneConfig(opts.sceneId);
    const refDir = path.resolve(__dirname, `../../../reference/lite/${config.slug}`);
    const goldenPath = path.join(refDir, "babylon-ref-golden.png");

    // Skip capture if golden already exists (unless RECAPTURE_GOLDEN is set)
    if (fs.existsSync(goldenPath) && !opts.force && !process.env.RECAPTURE_GOLDEN) {
        return goldenPath;
    }

    const timeout = opts.timeout ?? 60_000;
    const settleMs = opts.settleMs ?? 1500;

    // Open BJS ref page in a fresh context to avoid interfering with Lite page
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bjsPage = await context.newPage();
    const urlParams = opts.seekTime !== undefined ? `?seekTime=${opts.seekTime}${opts.queryParams ? `&${opts.queryParams}` : ""}` : opts.queryParams ? `?${opts.queryParams}` : "";
    await bjsPage.goto(`/babylon-ref-scene${opts.sceneId}.html${urlParams}`);

    // Wait for the BJS reference scene to signal ready (or surface its error).
    await waitForCanvasReady(bjsPage, { timeout, label: `captureGolden: BJS reference scene ${opts.sceneId}` });

    // For animated scenes, wait for animation freeze
    if (opts.seekTime !== undefined) {
        await waitForCanvasReady(bjsPage, { timeout, label: `captureGolden: BJS reference scene ${opts.sceneId}`, flag: "animationFrozen" });
    }

    // For frame-capture scenes, wait for the requested capture frame to be reached + frozen.
    if (opts.waitFlag) {
        await waitForCanvasReady(bjsPage, { timeout, label: `captureGolden: BJS reference scene ${opts.sceneId}`, flag: opts.waitFlag, pollMs: 100 });
    }

    // Wait for BJS loading screen to disappear (it overlays the canvas)
    await bjsPage
        .waitForFunction(() => !document.getElementById("babylonjsLoadingDiv"), { timeout: 10_000 })
        .catch(() => {
            // Loading div may never have appeared — that's fine
        });

    // GPU queue flush — extra time for heavy scenes with many textures
    await bjsPage.waitForTimeout(settleMs);

    // Hide any interactive UI buttons so they don't leak into the canvas screenshot.
    await bjsPage.addStyleTag({ content: "button { display: none !important; }" });

    // Screenshot canvas and save as golden
    fs.mkdirSync(refDir, { recursive: true });
    await bjsPage.locator("canvas").screenshot({ path: goldenPath });

    await bjsPage.close();
    await context.close();

    return goldenPath;
}
