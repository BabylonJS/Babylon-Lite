import { PNG } from "pngjs";
import { expect, test } from "../parity-fixtures";
import { getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(164);

test.skip(!!sceneConfig.skipParity, "Scene 164 skipped via skipParity in scene-config.json");

test("Scene 164 — Viewer-shaped device-loss recovery renders 50 valid frames", async ({ page }) => {
    await page.goto("/scene164.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.deviceLost === "true", { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.deviceRecovered === "true", { timeout: 30_000 });
    await page.waitForFunction(() => Number(document.querySelector("canvas")?.dataset.postRecoveryFrames ?? "0") >= 50, { timeout: 30_000 });
    await page.waitForTimeout(200);

    const canvas = page.locator("canvas");
    const state = await canvas.evaluate((element) => ({ ...(element as HTMLCanvasElement).dataset }));
    expect(state.error, `Scene threw: ${state.error}`).toBeUndefined();
    expect(state.recoveryFailed, `Recovery failed: ${state.recoveryFailed}`).toBeUndefined();
    expect(state.gpuError, `WebGPU reported an uncaptured error: ${state.gpuError}`).toBeUndefined();
    expect(state.deviceReplaced).toBe("true");
    expect(state.environmentIdentityPreserved).toBe("true");
    expect(state.environmentRebuilt).toBe("true");
    expect(state.fallbackRebuilt).toBe("true");
    expect(state.shadowRebuilt).toBe("true");

    const png = PNG.sync.read(await canvas.screenshot());
    let minLuminance = 255;
    let maxLuminance = 0;
    let sum = 0;
    let sumSquared = 0;
    const pixels = png.width * png.height;
    for (let i = 0; i < png.data.length; i += 4) {
        const luminance = (png.data[i]! * 54 + png.data[i + 1]! * 183 + png.data[i + 2]! * 19) / 256;
        minLuminance = Math.min(minLuminance, luminance);
        maxLuminance = Math.max(maxLuminance, luminance);
        sum += luminance;
        sumSquared += luminance * luminance;
    }
    const variance = sumSquared / pixels - (sum / pixels) ** 2;
    expect(maxLuminance - minLuminance, "Recovered output should contain visible environment-lit geometry and shadows").toBeGreaterThan(40);
    expect(variance, "Recovered output should not be empty or a flat clear color").toBeGreaterThan(100);

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
