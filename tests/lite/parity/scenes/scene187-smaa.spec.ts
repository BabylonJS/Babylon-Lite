import { expect, test } from "../parity-fixtures";
import { PNG } from "pngjs";

import { getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(187);

function comparePanels(png: PNG, region: { xMin: number; xMax: number; yMin: number; yMax: number }): { mad: number; changedRatio: number } {
    const panelWidth = png.width / 2;
    let difference = 0;
    let changed = 0;
    const pixelCount = (region.xMax - region.xMin) * (region.yMax - region.yMin);

    for (let y = region.yMin; y < region.yMax; y++) {
        for (let x = region.xMin; x < region.xMax; x++) {
            const leftOffset = (y * png.width + x) * 4;
            const rightOffset = (y * png.width + x + panelWidth) * 4;
            const pixelDifference =
                (Math.abs(png.data[leftOffset]! - png.data[rightOffset]!) +
                    Math.abs(png.data[leftOffset + 1]! - png.data[rightOffset + 1]!) +
                    Math.abs(png.data[leftOffset + 2]! - png.data[rightOffset + 2]!)) /
                3;
            difference += pixelDifference;
            changed += pixelDifference >= 4 ? 1 : 0;
        }
    }

    return {
        mad: difference / pixelCount,
        changedRatio: changed / pixelCount,
    };
}

function compareImages(a: PNG, b: PNG, region: { xMin: number; xMax: number; yMin: number; yMax: number }): { mad: number; changedRatio: number } {
    let difference = 0;
    let changed = 0;
    const pixelCount = (region.xMax - region.xMin) * (region.yMax - region.yMin);

    for (let y = region.yMin; y < region.yMax; y++) {
        for (let x = region.xMin; x < region.xMax; x++) {
            const offset = (y * a.width + x) * 4;
            const pixelDifference =
                (Math.abs(a.data[offset]! - b.data[offset]!) + Math.abs(a.data[offset + 1]! - b.data[offset + 1]!) + Math.abs(a.data[offset + 2]! - b.data[offset + 2]!)) / 3;
            difference += pixelDifference;
            changed += pixelDifference >= 1 ? 1 : 0;
        }
    }

    return {
        mad: difference / pixelCount,
        changedRatio: changed / pixelCount,
    };
}

test("Scene 187 presents the same stress image without AA and through SMAA", async ({ page }) => {
    test.setTimeout(120_000);
    expect(sceneConfig.skipParity).toBe(true);
    const loadedScripts: string[] = [];
    page.on("response", (response) => {
        if (response.request().resourceType() === "script") {
            loadedScripts.push(response.url());
        }
    });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/scene187.html");

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-comparison", "no-aa-left,smaa-right");
    await expect(canvas).toHaveAttribute("data-smaa", "true");
    await expect(canvas).toHaveAttribute("data-smaa-threshold", "0.03");
    await expect(canvas).toHaveAttribute("data-smaa-max-search-steps", "64");
    await expect(canvas).toHaveAttribute("data-smaa-diagonal-detection", "false");
    await expect(canvas).toHaveAttribute("data-smaa-min-diagonal-run", "4");
    await expect(canvas).toHaveAttribute("data-smaa-corner-detection", "false");
    await expect(canvas).toHaveAttribute("data-smaa-dominant-axis-blend", "true");
    await expect(canvas).toHaveAttribute("data-smaa-source-is-srgb", "false");
    await expect(canvas).toHaveAttribute("data-smaa-debug", "false");
    await expect(canvas).not.toHaveAttribute("data-error", /.+/);
    expect(loadedScripts.some((url) => url.includes("scene187-debug"))).toBe(false);

    await page.waitForTimeout(250);
    const screenshot = PNG.sync.read(await canvas.screenshot());
    const shallowEdges = comparePanels(screenshot, { xMin: 35, xMax: 605, yMin: 75, yMax: 270 });
    const fullChart = comparePanels(screenshot, { xMin: 20, xMax: 620, yMin: 70, yMax: 700 });

    expect(shallowEdges.mad).toBeGreaterThan(0.05);
    expect(shallowEdges.changedRatio).toBeGreaterThan(0.001);
    expect(fullChart.mad).toBeGreaterThan(0.03);
    expect(fullChart.changedRatio).toBeGreaterThan(0.001);
});

test("Scene 187 exposes live SMAA controls with debug=1", async ({ page }) => {
    test.setTimeout(120_000);
    const loadedScripts: string[] = [];
    page.on("response", (response) => {
        if (response.request().resourceType() === "script") {
            loadedScripts.push(response.url());
        }
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/scene187.html?debug=1");

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-smaa-debug", "true");
    await expect(page.locator("[data-smaa-controls=true]")).toBeVisible();
    expect(loadedScripts.some((url) => url.includes("scene187-debug"))).toBe(true);

    const withoutCornerDetection = PNG.sync.read(await canvas.screenshot());
    await page.locator("[data-smaa-control=cornerDetection]").check();
    await expect(canvas).toHaveAttribute("data-smaa-corner-detection", "true");
    await page.waitForTimeout(100);
    const withCornerDetection = PNG.sync.read(await canvas.screenshot());
    const cornerDifference = compareImages(withoutCornerDetection, withCornerDetection, { xMin: 640, xMax: 1280, yMin: 0, yMax: 720 });
    expect(cornerDifference.mad).toBeGreaterThan(0.001);
    expect(cornerDifference.changedRatio).toBeGreaterThan(0.0001);

    const setRange = async (key: string, value: string): Promise<void> => {
        await page.locator(`[data-smaa-control=${key}]`).evaluate((element, nextValue) => {
            const input = element as HTMLInputElement;
            input.value = nextValue;
            input.dispatchEvent(new Event("input", { bubbles: true }));
        }, value);
    };

    await setRange("threshold", "0.08");
    await setRange("maxSearchSteps", "96");
    await setRange("minDiagonalRun", "8");
    await page.locator("[data-smaa-control=diagonalDetection]").check();
    await page.locator("[data-smaa-control=dominantAxisBlend]").uncheck();
    await page.locator("[data-smaa-control=sourceIsSrgb]").check();

    await expect(canvas).toHaveAttribute("data-smaa-threshold", "0.08");
    await expect(canvas).toHaveAttribute("data-smaa-max-search-steps", "96");
    await expect(canvas).toHaveAttribute("data-smaa-min-diagonal-run", "8");
    await expect(canvas).toHaveAttribute("data-smaa-diagonal-detection", "true");
    await expect(canvas).toHaveAttribute("data-smaa-corner-detection", "true");
    await expect(canvas).toHaveAttribute("data-smaa-dominant-axis-blend", "false");
    await expect(canvas).toHaveAttribute("data-smaa-source-is-srgb", "true");

    await page.locator("[data-smaa-reset=true]").click();
    await expect(canvas).toHaveAttribute("data-smaa-threshold", "0.03");
    await expect(canvas).toHaveAttribute("data-smaa-max-search-steps", "64");
    await expect(canvas).toHaveAttribute("data-smaa-diagonal-detection", "false");
    await expect(canvas).toHaveAttribute("data-smaa-min-diagonal-run", "4");
    await expect(canvas).toHaveAttribute("data-smaa-corner-detection", "false");
    await expect(canvas).toHaveAttribute("data-smaa-dominant-axis-blend", "true");
    await expect(canvas).toHaveAttribute("data-smaa-source-is-srgb", "false");
});
