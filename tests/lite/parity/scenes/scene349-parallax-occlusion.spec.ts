import { test, expect } from "../parity-fixtures";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SCENE349_CAMERAS } from "../../../../lab/lite/src/shared/scene349-parallax.js";
import { attachCompareArtifacts, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const config = getSceneConfig(349);
const referenceDir = resolve(__dirname, "../../../../reference/lite", config.slug);
const golden = resolve(referenceDir, "babylon-ref-golden.png");
test.use({ baseURL: `http://127.0.0.1:${process.env.LAB_TEST_PORT ?? 5179}` });

// Strict parity is intentionally skipped in scene-config. This test retains
// an inspectable comparison without inventing an equivalence threshold.
test("Scene 349 - render independent POM for visual comparison", async ({ page }, testInfo) => {
    expect(existsSync(golden), "Scene 349's captured Babylon.js comparison reference must exist").toBe(true);
    await page.goto("/scene349.html?embed=1&view=grazing");
    await waitForCanvasReady(page, { timeout: 30_000, label: "scene349 Lite POM" });
    await expect(page.locator("#loader-overlay")).toHaveCount(0);
    await expect(page.locator("canvas")).toHaveAttribute("data-draw-calls", "4");
    await expect(page.locator("canvas")).toHaveAttribute("data-view", "grazing");
    await expect(page.locator("canvas")).toHaveAttribute("data-camera-alpha", String(SCENE349_CAMERAS.grazing.alpha));
    await expect(page.locator("canvas")).toHaveAttribute("data-camera-beta", String(SCENE349_CAMERAS.grazing.beta));
    await expect(page.locator("canvas")).toHaveAttribute("data-camera-radius", String(SCENE349_CAMERAS.grazing.radius));
    const actual = resolve(referenceDir, "test-actual.png");
    await page.locator("canvas").screenshot({ path: actual });
    const difference = compareImages(actual, golden);
    await testInfo.attach("algorithm-comparison", {
        body: JSON.stringify(
            {
                purpose: "Native Babylon.js marching vs independent Lite contact refinement; not a pixel-parity gate",
                ...difference,
            },
            null,
            2
        ),
        contentType: "application/json",
    });
    await attachCompareArtifacts(testInfo, actual, golden, referenceDir);
});
