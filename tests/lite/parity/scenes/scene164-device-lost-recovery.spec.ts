/**
 * Scene 164 — WebGPU device-lost recovery.
 *
 * Device loss is not a visual feature, so this scene has no stable-Babylon counterpart and no
 * golden reference. The property under test is invariance: after the device is destroyed and
 * the scene is rebuilt on a replacement device, it must render the same image it rendered
 * before the loss. The spec therefore diffs two screenshots of the *same* Lite run — the
 * animation-pinned frame captured just before the loss, and the settled frame captured after
 * recovery — instead of comparing against an external reference.
 */
import * as fs from "fs";
import { PNG } from "pngjs";
import { expect, test } from "../parity-fixtures";
import { getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(164);

test.skip(!!sceneConfig.skipParity, "Scene 164 skipped via skipParity in scene-config.json");

/** Mean absolute per-channel difference (0–255) between two screenshots, which must be the same size. */
function screenshotMad(a: Buffer, b: Buffer): number {
    const before = PNG.sync.read(a);
    const after = PNG.sync.read(b);
    // A canvas resize across the loss would make any overlap-only diff meaningless: the compared
    // region would no longer show the same part of the scene, so a silent pass would be a false one.
    if (before.width !== after.width || before.height !== after.height) {
        throw new Error(`Canvas size changed across recovery: ${before.width}x${before.height} before, ${after.width}x${after.height} after.`);
    }
    let sumDiff = 0;

    for (let i = 0; i < before.data.length; i += 4) {
        sumDiff += (Math.abs(before.data[i]! - after.data[i]!) + Math.abs(before.data[i + 1]! - after.data[i + 1]!) + Math.abs(before.data[i + 2]! - after.data[i + 2]!)) / 3;
    }

    return sumDiff / (before.width * before.height);
}

test("Scene 164 — device-lost recovery reproduces the pre-loss image", async ({ page }, testInfo) => {
    await page.goto("/scene164.html");
    const canvas = page.locator("canvas");

    // The scene pins its animation to a fixed frame, flags `preLossReady`, then waits for
    // `captured` before destroying the device, so this screenshot cannot race the loss.
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.preLossReady === "true", { timeout: 30_000 });
    const beforeShot = await canvas.screenshot();
    await page.evaluate(() => ((document.querySelector("canvas") as HTMLCanvasElement).dataset.captured = "true"));

    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.deviceLost === "true", { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.deviceRecovered === "true", { timeout: 30_000 });
    await page.waitForFunction(() => Number(document.querySelector("canvas")?.dataset.postRecoveryFrames ?? "0") >= 20, { timeout: 30_000 });
    await page.waitForTimeout(200);

    const state = await canvas.evaluate((element) => ({ ...(element as HTMLCanvasElement).dataset }));
    expect(state.error, `Scene threw: ${state.error}`).toBeUndefined();
    expect(state.recoveryFailed, `Recovery failed: ${state.recoveryFailed}`).toBeUndefined();
    expect(state.gpuError, `WebGPU reported an uncaptured error: ${state.gpuError}`).toBeUndefined();

    // Recovery must install a genuinely new device and rebuild the resources the generic
    // material/mesh walk cannot reach, while preserving the caller's object identities.
    expect(state.deviceReplaced).toBe("true");
    expect(state.environmentIdentityPreserved).toBe("true");
    expect(state.environmentRebuilt).toBe("true");
    expect(state.fallbackRebuilt).toBe("true");
    expect(state.shadowRebuilt).toBe("true");
    expect(state.backgroundsRebuilt).toBe("true");

    const afterShot = await canvas.screenshot();
    const mad = screenshotMad(beforeShot, afterShot);

    console.log(`Pre-loss vs post-recovery MAD=${mad.toFixed(4)}`);

    const beforePath = testInfo.outputPath("scene164-before-loss.png");
    const afterPath = testInfo.outputPath("scene164-after-recovery.png");
    fs.writeFileSync(beforePath, beforeShot);
    fs.writeFileSync(afterPath, afterShot);
    await testInfo.attach("scene164-before-loss.png", { path: beforePath, contentType: "image/png" });
    await testInfo.attach("scene164-after-recovery.png", { path: afterPath, contentType: "image/png" });

    expect(mad, `Post-recovery image should match the pre-loss image within MAD ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);

    // Viewer-shaped teardown after recovery: environment textures are owned by a recovery-installed
    // disposable while the loader's original disposable still holds the pre-loss textures, so
    // disposing post-recovery must not double-destroy or emit uncaptured errors.
    await page.evaluate(() => (globalThis as { __scene164Dispose?: () => void }).__scene164Dispose?.());
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.disposed === "true", { timeout: 30_000 });
    await page.waitForTimeout(200);

    const afterDispose = await canvas.evaluate((element) => ({ ...(element as HTMLCanvasElement).dataset }));
    expect(afterDispose.error, `Disposal after recovery threw: ${afterDispose.error}`).toBeUndefined();
    expect(afterDispose.gpuError, `Disposal after recovery reported an uncaptured WebGPU error: ${afterDispose.gpuError}`).toBeUndefined();
});
