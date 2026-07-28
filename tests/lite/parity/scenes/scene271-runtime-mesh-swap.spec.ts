/**
 * Scene 271 — Runtime mesh swap with a shared material texture.
 *
 * Removes a textured mesh and adds a clone that shares its material — and therefore its ref-counted
 * diffuse texture — from inside `onBeforeRender`, i.e. in the middle of a frame.
 *
 * `removeFromScene` used to run its GPU teardown synchronously, dropping the shared texture to
 * refcount zero and destroying the GPUTexture. The clone's renderable, rebuilt later in the SAME
 * frame by the material-swap drain, then bound an already-destroyed texture — WebGPU reported
 * "Destroyed texture used in a submit" and the canvas went black. Teardown is now retired until
 * after the frame submits, so the rebuild re-acquires the texture before the release lands.
 *
 * Two independent assertions: no uncaptured WebGPU error (the precise failure signature), and the
 * post-swap image matching the Babylon.js reference (the user-visible symptom).
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(271);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene271-runtime-mesh-swap");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 271 skipped via skipParity in scene-config.json");

test("Scene 271 — runtime mesh swap keeps the shared texture alive and matches Babylon.js", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 271 });

    await page.goto("/scene271.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.swapped === "true", { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(200);

    const canvasData = await page.locator("canvas").evaluate((canvas) => ({ ...(canvas as HTMLCanvasElement).dataset }));
    expect(canvasData.error, `Scene threw: ${canvasData.error}`).toBeUndefined();
    // The regression's exact signature — a destroyed texture reaching a submit.
    expect(canvasData.gpuError, `WebGPU reported an uncaptured error: ${canvasData.gpuError}`).toBeUndefined();

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD: ${full.mad.toFixed(3)} (limit ${sceneConfig.maxMad})`);
    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
