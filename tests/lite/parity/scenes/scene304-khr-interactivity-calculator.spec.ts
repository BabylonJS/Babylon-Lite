import { expect, test } from "../parity-fixtures";
import { PNG } from "pngjs";

import { getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(304);

interface CalculatorState {
    selectedNumber(): unknown;
    displayOffsets(): unknown[];
}

function colorfulPixelCount(png: PNG): number {
    let count = 0;
    for (let offset = 0; offset < png.data.length; offset += 4 * 16) {
        const max = Math.max(png.data[offset]!, png.data[offset + 1]!, png.data[offset + 2]!);
        const min = Math.min(png.data[offset]!, png.data[offset + 1]!, png.data[offset + 2]!);
        if (max - min > 8) {
            count++;
        }
    }
    return count;
}

test("Scene 304 executes the Khronos Calculator KHR_interactivity graph", async ({ page }) => {
    test.setTimeout(90_000);
    expect(sceneConfig.skipParity).toBe(true);

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/scene304.html");

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(canvas).not.toHaveAttribute("data-error", /.+/);
    await expect(canvas).toHaveAttribute("data-graph-count", "1");

    const initial = await page.evaluate(() => {
        const api = (window as unknown as { __scene304: CalculatorState }).__scene304;
        return { selected: api.selectedNumber(), offsets: api.displayOffsets() };
    });
    expect(initial.selected).toBe(0);

    await canvas.click({ position: { x: 685, y: 380 } });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __scene304: CalculatorState }).__scene304.selectedNumber())).toBe(9);
    const afterNine = await page.evaluate(() => {
        const api = (window as unknown as { __scene304: CalculatorState }).__scene304;
        return { selected: api.selectedNumber(), offsets: api.displayOffsets() };
    });
    expect(afterNine.offsets).not.toEqual(initial.offsets);

    await canvas.click({ position: { x: 600, y: 322 } });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __scene304: CalculatorState }).__scene304.selectedNumber())).toBe(0);

    const screenshot = PNG.sync.read(await canvas.screenshot());
    expect(colorfulPixelCount(screenshot)).toBeGreaterThan(100);
});
