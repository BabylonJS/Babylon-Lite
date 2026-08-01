import { test, expect } from "../parity-fixtures";
import * as fs from "fs";
import * as path from "path";
import { PNG } from "pngjs";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(275);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene275-msdf-text-alpha-to-coverage");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

function countMixedCoveragePixels(imagePath: string): number {
    const png = PNG.sync.read(fs.readFileSync(imagePath));
    let count = 0;
    for (let i = 0; i < png.data.length; i += 4) {
        const red = png.data[i]!;
        const green = png.data[i + 1]!;
        if (red > 60 && green > 60) {
            count++;
        }
    }
    return count;
}

test("Scene 275 — depth-writing MSDF text uses fractional A2C coverage", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 275, timeout: 60_000 });

    await page.goto("/scene275.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    expect(await page.locator("canvas").getAttribute("data-sample-count")).toBe("4");

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    expect(countMixedCoveragePixels(screenshotPath), "front/rear text colors should mix at fractionally covered glyph edges").toBeGreaterThan(100);
    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
