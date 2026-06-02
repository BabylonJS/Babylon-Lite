/**
 * Memory Leak Detection Tests
 *
 * Runs multiple create → render → dispose cycles for each scene and measures
 * JS heap growth via Chrome DevTools Protocol. A monotonic heap increase across
 * cycles indicates a memory leak (detached DOM, unreleased GPU wrappers,
 * stale closures, uncleaned caches, etc.).
 *
 * Run:  pnpm test:perf
 *   or: LEAK_SCENES=1,2 npx playwright test --config playwright.perf.config.ts memory-leak
 *
 * How it works:
 *   1. Opens leak-test.html?scene=N (a harness that exposes window.__leakTest)
 *   2. For each cycle: calls __leakTest.runCycle() then forces GC via CDP
 *   3. Reads JSHeapUsedSize after each cycle
 *   4. Asserts heap growth from cycle 2→N is within tolerance
 *      (cycle 1→2 is excluded as JIT/cache warmup)
 */
import { test, expect } from "@playwright/test";
import type { CDPSession } from "@playwright/test";

// ── Configuration ──────────────────────────────────────────────────

const CYCLES = 5;
const SETTLE_MS = 200;
// Max allowed heap growth per cycle after warmup (bytes)
const MAX_GROWTH_PER_CYCLE = 128 * 1024; // 128 KB

interface SceneDef {
    num: number;
    label: string;
}

const ALL_SCENES: SceneDef[] = [
    { num: 1, label: "Scene 1 — BoomBox PBR" },
    { num: 2, label: "Scene 2 — Sphere + PointLight" },
    { num: 9, label: "Scene 9 — Sponza (.babylon)" },
];

const SELECTED = process.env.LEAK_SCENES ? process.env.LEAK_SCENES.split(",").map((s) => parseInt(s.trim(), 10)) : null;

const SCENES = SELECTED ? ALL_SCENES.filter((s) => SELECTED.includes(s.num)) : ALL_SCENES;

// ── CDP helpers ────────────────────────────────────────────────────

async function forceGC(cdp: CDPSession): Promise<void> {
    await cdp.send("HeapProfiler.collectGarbage");
    // Double GC + settle to let weak refs and PolyFills flush
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    await cdp.send("HeapProfiler.collectGarbage");
    await new Promise((r) => setTimeout(r, SETTLE_MS));
}

async function getJSHeapUsed(cdp: CDPSession): Promise<number> {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const heap = metrics.find((m: { name: string }) => m.name === "JSHeapUsedSize");
    return heap ? (heap as { value: number }).value : 0;
}

// ── Tests ──────────────────────────────────────────────────────────

test.describe("Memory Leak Detection", () => {
    for (const scene of SCENES) {
        test(`${scene.label} — no leak across ${CYCLES} cycles`, async ({ browser }) => {
            const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
            const page = await context.newPage();
            const cdp = await page.context().newCDPSession(page);
            await cdp.send("Performance.enable");
            await cdp.send("HeapProfiler.enable");

            await page.goto(`/leak-test.html?scene=${scene.num}`, { waitUntil: "domcontentloaded" });

            // Wait for harness to be ready
            await page.waitForFunction(() => (window as any).__leakTest?.ready === true, { timeout: 15_000 });

            const heapSizes: number[] = [];

            for (let i = 0; i < CYCLES; i++) {
                // Run one create → render → dispose cycle
                const error = await page.evaluate(async () => {
                    await (window as any).__leakTest.runCycle();
                    return (window as any).__leakTest.error;
                });

                if (error) {
                    throw new Error(`Cycle ${i + 1} failed: ${error}`);
                }

                // Force GC and measure heap
                await forceGC(cdp);
                const heap = await getJSHeapUsed(cdp);
                heapSizes.push(heap);
            }

            await cdp.send("HeapProfiler.disable");
            await cdp.send("Performance.disable");
            await page.close();
            await context.close();

            // Report
            const heapKB = heapSizes.map((h) => (h / 1024).toFixed(0));
            console.log(`  ${scene.label}:`);
            console.log(`    Heap after each cycle (KB): ${heapKB.join(" → ")}`);

            // Calculate growth from cycle 2 onward (skip warmup cycle 1→2)
            if (heapSizes.length >= 3) {
                const postWarmup = heapSizes.slice(1); // cycles 2, 3, 4, 5
                const growthPerCycle = (postWarmup[postWarmup.length - 1] - postWarmup[0]) / (postWarmup.length - 1);

                const growthKB = (growthPerCycle / 1024).toFixed(1);
                const totalGrowthKB = ((postWarmup[postWarmup.length - 1] - postWarmup[0]) / 1024).toFixed(1);
                console.log(`    Post-warmup growth: ${totalGrowthKB} KB total, ${growthKB} KB/cycle`);

                expect(
                    growthPerCycle,
                    `Heap grew ${growthKB} KB/cycle (limit: ${(MAX_GROWTH_PER_CYCLE / 1024).toFixed(0)} KB). ` + `Sizes (KB): ${heapKB.join(" → ")}`
                ).toBeLessThanOrEqual(MAX_GROWTH_PER_CYCLE);
            }
        });
    }
});
