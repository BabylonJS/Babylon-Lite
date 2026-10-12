import { expect, test } from "@playwright/test";
import { compareImages, compareRegion } from "../parity/compare-utils";

interface UsdMetrics {
    sourceMeshes: number;
    thinInstances: number;
    triangles: number;
    loadMs: number;
    firstInstanceX: number;
    lastInstanceX: number;
}

async function readMetrics(page: import("@playwright/test").Page, url: string): Promise<UsdMetrics> {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
        () => {
            const canvas = document.querySelector("canvas");
            if (canvas?.dataset.error) {
                throw new Error(canvas.dataset.error);
            }
            return canvas?.dataset.ready === "true";
        },
        undefined,
        { timeout: 120_000 }
    );
    return await page.locator("canvas").evaluate((canvas) => ({
        sourceMeshes: Number(canvas.dataset.sourceMeshes),
        thinInstances: Number(canvas.dataset.thinInstances),
        triangles: Number(canvas.dataset.triangles),
        loadMs: Number(canvas.dataset.loadMs),
        firstInstanceX: Number(canvas.dataset.firstInstanceX),
        lastInstanceX: Number(canvas.dataset.lastInstanceX),
    }));
}

test("USD point-instancer semantics match Babylon.js", async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext();
    try {
        const litePage = await context.newPage();
        const bjsPage = await context.newPage();
        const [lite, bjs] = await Promise.all([readMetrics(litePage, "/lite/usd-performance.html"), readMetrics(bjsPage, "/lite/babylon-ref-usd-performance.html")]);

        expect(lite.sourceMeshes).toBe(bjs.sourceMeshes);
        expect(lite.thinInstances).toBe(bjs.thinInstances);
        expect(lite.triangles).toBe(bjs.triangles);
        expect(lite.firstInstanceX).toBe(bjs.firstInstanceX);
        expect(lite.lastInstanceX).toBe(bjs.lastInstanceX);
        expect(lite).toMatchObject({ sourceMeshes: 1, thinInstances: 10_000, triangles: 1, firstInstanceX: -50, lastInstanceX: 49 });
        expect(lite.loadMs).toBeGreaterThan(0);
        expect(bjs.loadMs).toBeGreaterThan(0);
    } finally {
        await context.close();
    }
});

test.describe("USD protocol-v5 browser features", () => {
    for (const [asset, expected] of [
        ["materials", { meshes: 3, pluginMaterials: 3, textures: 5 }],
        ["morph", { targetCount: 3, influenceTracks: 3 }],
        ["bind", { parent: "Rig", firstPosition: 7, rootBoneY: 3, childBoneY: 3 }],
        ["layers", { meshes: 1, name: "ComposedCube", missingAssets: [] }],
    ] as const) {
        test(asset, async ({ page }) => {
            test.setTimeout(120_000);
            await page.goto(`/lite/usd-features.html?asset=${asset}`, { waitUntil: "domcontentloaded" });
            await page.waitForFunction(
                () => {
                    const canvas = document.querySelector("canvas");
                    if (canvas?.dataset.error) {
                        throw new Error(canvas.dataset.error);
                    }
                    return canvas?.dataset.ready === "true";
                },
                undefined,
                { timeout: 120_000 }
            );
            const result = await page.locator("canvas").evaluate((canvas) => JSON.parse(canvas.dataset.result ?? "{}") as unknown);
            expect(result).toMatchObject(expected);
            if (asset === "morph") {
                const influences = (result as { influences: number[] }).influences;
                expect(influences[0]).toBeCloseTo(0);
                expect(influences[1]).toBeCloseTo(0.2);
                expect(influences[2]).toBeCloseTo(1);
            }
        });
    }
});

test.describe("USD rendering matches Babylon.js", () => {
    for (const [asset, maxMad, maxRegionMad] of [
        ["materials", 1.5, 4],
        ["analytic", 0.5, 2],
        ["skin", 0.5, 2],
    ] as const) {
        test(asset, async ({ browser }, testInfo) => {
            test.setTimeout(180_000);
            const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
            try {
                const capture = async (url: string, name: string): Promise<string> => {
                    const page = await context.newPage();
                    await page.goto(url, { waitUntil: "domcontentloaded" });
                    await page.waitForFunction(
                        () => {
                            const canvas = document.querySelector("canvas");
                            if (canvas?.dataset.error) {
                                throw new Error(canvas.dataset.error);
                            }
                            return canvas?.dataset.ready === "true";
                        },
                        undefined,
                        { timeout: 120_000 }
                    );
                    const path = testInfo.outputPath(name);
                    await page.locator("canvas").screenshot({ path });
                    await page.close();
                    return path;
                };
                const lite = await capture(`/lite/usd-visual.html?asset=${asset}`, `${asset}-lite.png`);
                const bjs = await capture(`/lite/babylon-ref-usd-visual.html?asset=${asset}`, `${asset}-babylon.png`);
                await testInfo.attach(`${asset}-lite`, { path: lite, contentType: "image/png" });
                await testInfo.attach(`${asset}-babylon`, { path: bjs, contentType: "image/png" });

                const full = compareImages(lite, bjs);
                const region = compareRegion(lite, bjs, [10, 13, 20], 5);
                expect(full.mad, `${asset} full-image MAD`).toBeLessThanOrEqual(maxMad);
                expect(region.regionPixels, `${asset} must render visible geometry`).toBeGreaterThan(1_000);
                expect(region.mad, `${asset} visible-region MAD`).toBeLessThanOrEqual(maxRegionMad);
            } finally {
                await context.close();
            }
        });
    }
});
