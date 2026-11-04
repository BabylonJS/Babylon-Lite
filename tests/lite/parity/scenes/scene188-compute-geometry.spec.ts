import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(188);
const referenceDir = path.resolve(__dirname, "../../../../reference/lite/scene188-compute-geometry");
const golden = path.join(referenceDir, "babylon-ref-golden.png");

test("Scene 188 — compute-generated storage geometry matches the reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 188, settleMs: 500 });
    await page.goto("/scene188.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await expect(page.locator("canvas")).toHaveAttribute("data-first-frame-compute", "true");
    await page.locator("#loader-overlay").waitFor({ state: "detached" });
    const actual = path.join(referenceDir, "test-actual.png");
    await page.locator("canvas").screenshot({ path: actual });
    const result = compareImages(actual, golden);
    await attachCompareArtifacts(testInfo, actual, golden, referenceDir);
    expect(result.mad).toBeLessThanOrEqual(sceneConfig.maxMad);
});
