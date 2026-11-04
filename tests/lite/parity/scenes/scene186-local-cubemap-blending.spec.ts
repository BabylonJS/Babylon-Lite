import { expect, test } from "../parity-fixtures";
import { PNG } from "pngjs";

import { getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(186);

function pixelRgb(png: PNG, x: number, y: number): number[] {
    const offset = (y * png.width + x) * 4;
    return [png.data[offset]!, png.data[offset + 1]!, png.data[offset + 2]!];
}

function imageDifference(a: PNG, b: PNG, region?: { xMin: number; xMax: number; yMin: number; yMax: number }): { mad: number; changedRatio: number } {
    expect(a.width).toBe(b.width);
    expect(a.height).toBe(b.height);
    let difference = 0;
    let changed = 0;
    const bounds = region ?? { xMin: 0, xMax: a.width, yMin: 0, yMax: a.height };
    const pixelCount = (bounds.xMax - bounds.xMin) * (bounds.yMax - bounds.yMin);
    for (let y = bounds.yMin; y < bounds.yMax; y++) {
        for (let x = bounds.xMin; x < bounds.xMax; x++) {
            const offset = (y * a.width + x) * 4;
            const pixelDifference =
                (Math.abs(a.data[offset]! - b.data[offset]!) + Math.abs(a.data[offset + 1]! - b.data[offset + 1]!) + Math.abs(a.data[offset + 2]! - b.data[offset + 2]!)) / 3;
            difference += pixelDifference;
            changed += pixelDifference >= 8 ? 1 : 0;
        }
    }
    return {
        mad: difference / pixelCount,
        changedRatio: changed / pixelCount,
    };
}

test("Scene 186 exposes two probes and a real blended transition", async ({ page }) => {
    test.setTimeout(120_000);
    expect(sceneConfig.skipParity).toBe(true);

    await page.setViewportSize({ width: 1280, height: 720 });
    const canvas = page.locator("#renderCanvas");
    await page.goto("/scene186.html");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-local-cubemap", "true");
    await expect(canvas).toHaveAttribute("data-local-cubemap-blending", "true");
    await expect(canvas).toHaveAttribute("data-comparison", "hard-left,blended-right");

    await page.goto("/scene186.html?local=0");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-local-cubemap", "false");
    await expect(canvas).toHaveAttribute("data-environment", "per-floor");
    await page.waitForTimeout(250);
    const globalEnvironment = PNG.sync.read(await canvas.screenshot());

    await page.goto("/scene186.html?local=1&blend=1");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-comparison", "hard-left,blended-right");

    await page.goto("/scene186.html?local=1&blend=1&debug=1&compare=0");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-local-cubemap", "true");
    await expect(canvas).toHaveAttribute("data-local-cubemap-blending", "true");
    await expect(canvas).toHaveAttribute("data-local-cubemap-debug", "true");
    await expect(canvas).toHaveAttribute("data-probe-helpers", "inner-influence-wireframes,outer-influence-wireframe,capture-spheres");
    await expect(canvas).not.toHaveAttribute("data-error", /.+/);
    await page.waitForTimeout(250);

    const debug = PNG.sync.read(await canvas.screenshot());
    const left = pixelRgb(debug, 500, 400);
    const center = pixelRgb(debug, 600, 400);
    const right = pixelRgb(debug, 800, 400);
    expect(left[0]).toBeGreaterThan(left[2]! + 80);
    expect(right[2]).toBeGreaterThan(right[0]! + 80);
    expect(center[0]).toBeGreaterThan(50);
    expect(center[2]).toBeGreaterThan(50);
    expect(Math.abs(center[0]! - center[2]!)).toBeLessThan(80);

    await page.goto("/scene186.html?local=1&blend=1&compare=0");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await page.waitForTimeout(250);
    const blended = PNG.sync.read(await canvas.screenshot());

    await page.goto("/scene186.html?local=1&blend=0");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-local-cubemap-blending", "false");
    await page.waitForTimeout(250);
    const hardAssigned = PNG.sync.read(await canvas.screenshot());

    const difference = imageDifference(blended, hardAssigned, { xMin: 500, xMax: 800, yMin: 350, yMax: 520 });
    expect(difference.mad).toBeGreaterThan(0.5);

    const localDifference = imageDifference(globalEnvironment, hardAssigned);
    expect(localDifference.mad).toBeGreaterThan(0.25);
    expect(localDifference.changedRatio).toBeGreaterThan(0.01);
});
