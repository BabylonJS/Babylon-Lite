import { existsSync } from "node:fs";
import * as path from "node:path";
import { expect, test } from "../parity-fixtures";
import { attachCompareArtifacts, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(354);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene354-mesh-opacity");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 354 skipped via skipParity in scene-config.json");

// Region (a): direct BJS visibility on programmatic Standard/PBR with opaque shared-material twins.
// Region (b): NORMALIZED oracle for intentional glTF OPAQUE/MASK fading; not raw BJS visibility parity.
// MASK bands 128..224 survive the original cutoff even when alpha * opacity falls below 0.5.
// Full-strength shadows at zero and A2C + blend are separately normalized Lite policy samples.
test("Scene 354 — mesh opacity matches direct and normalized oracle regions", async ({ page }, testInfo) => {
    expect(existsSync(GOLDEN_REF), "Capture the explicitly authorized new BJS oracle golden before running parity; never generate it at test time").toBe(true);
    await page.goto("/scene354.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", undefined, { timeout: 30_000 });
    await expect(page.locator("canvas")).toHaveAttribute("data-opacity-mode", "feature");
    await expect(page.locator("canvas")).toHaveAttribute("data-sample-count", "4");
    await page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 });
    const actual = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: actual });
    const result = compareImages(actual, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, actual, GOLDEN_REF, REFERENCE_DIR);
    expect(result.mad).toBeLessThanOrEqual(sceneConfig.maxMad);
});
