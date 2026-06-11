/**
 * Capture thumbnails for the multi-canvas demo scenes (225, 226) — one-off
 * helper that hits the running dev server (http://localhost:5174), waits for
 * `canvas.dataset.ready === "true"`, and writes downscaled 1280×720 JPGs to
 * lab/public/thumbnails/sceneNNN.jpg.
 *
 * Run with:  npx tsx scripts/capture-multi-canvas-thumbnails.ts
 *
 * Requires the lab dev server to be running (pnpm --filter @babylon-lite/lab dev
 * or pnpm dev:lab). This script is intentionally kept simple — it isn't wired
 * into any pipeline; delete it after the thumbnails land.
 */
import { chromium } from "@playwright/test";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { measurementBrowserArgs } from "./bundle-scenes-core";

const SCENES: { id: number; slug: string }[] = [
    { id: 225, slug: "scene225-multi-canvas-same-scene" },
    { id: 226, slug: "scene226-multi-canvas-different-scenes" },
];

const BASE_URL = process.env.LAB_URL ?? "http://localhost:5174";
const OUT_DIR = resolve(__dirname, "..", "lab", "public", "thumbnails");

async function captureOne(scene: { id: number; slug: string }): Promise<void> {
    const browser = await chromium.launch({ channel: "chrome", headless: true, args: measurementBrowserArgs() });
    try {
        // Capture at exactly 1280×720, deviceScaleFactor 1 — matches the
        // committed thumbnail convention (GUIDANCE.md §2b″).
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        page.on("pageerror", (e) => console.error(`[scene${scene.id}] pageerror:`, e.message));
        page.on("console", (msg) => {
            if (msg.type() === "error") console.error(`[scene${scene.id}] console.error:`, msg.text());
        });

        await page.goto(`${BASE_URL}/lite/scene${scene.id}.html`, { waitUntil: "domcontentloaded" });
        // Both canvases set `dataset.ready = "true"` in scene225/226.ts main().
        await page.waitForFunction(
            () => {
                const cs = Array.from(document.querySelectorAll("canvas")) as HTMLCanvasElement[];
                return cs.length > 0 && cs.every((c) => c.dataset.ready === "true");
            },
            { timeout: 30_000 }
        );
        // Let the first rendered frame settle.
        await page.waitForTimeout(500);

        const jpgBuffer = await page.screenshot({ type: "jpeg", quality: 78, fullPage: false });
        const outPath = resolve(OUT_DIR, `scene${scene.id}.jpg`);
        writeFileSync(outPath, jpgBuffer);
        console.log(`Wrote ${outPath} (${(jpgBuffer.length / 1024).toFixed(1)} KB)`);
        await context.close();
    } finally {
        await browser.close();
    }
}

(async () => {
    for (const scene of SCENES) {
        await captureOne(scene);
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
