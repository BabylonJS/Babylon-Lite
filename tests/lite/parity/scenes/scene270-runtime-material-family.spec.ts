/**
 * Scene 270 — Introducing a new material family at runtime.
 *
 * Registers a StandardMaterial-only scene, then adds the first PBR mesh from inside
 * `onBeforeRender`.
 *
 * The material-swap drain used to skip any mesh whose material group had never been built — which is
 * exactly the state `addToScene` leaves a brand-new group in once the scene is built, since deferred
 * builders only run at boot — and then cleared the queue. The mesh therefore never got a renderable:
 * invisible, with no error and no warning. It is now routed to the runtime build path.
 *
 * The image comparison is the real assertion here: before the fix the Lite frame is simply missing
 * the PBR box that the Babylon.js reference draws.
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(270);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene270-runtime-material-family");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 270 skipped via skipParity in scene-config.json");

test("Scene 270 — a PBR mesh added at runtime renders and matches Babylon.js", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 270, timeout: 60_000 });

    await page.goto("/scene270.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.added === "true", { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(200);

    const canvasData = await page.locator("canvas").evaluate((canvas) => ({ ...(canvas as HTMLCanvasElement).dataset }));
    expect(canvasData.error, `Scene threw: ${canvasData.error}`).toBeUndefined();
    expect(canvasData.gpuError, `WebGPU reported an uncaptured error: ${canvasData.gpuError}`).toBeUndefined();

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD: ${full.mad.toFixed(3)} (limit ${sceneConfig.maxMad})`);
    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
