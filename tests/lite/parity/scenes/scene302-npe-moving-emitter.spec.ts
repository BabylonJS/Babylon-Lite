import { PNG } from "pngjs";
import * as path from "path";

import { SCENE302_CAPTURE_SEEK_TIME } from "../../../../lab/lite/src/shared/scene302-npe-moving-emitter";
import { expect, test } from "../parity-fixtures";
import { attachCompareArtifacts, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(302);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene302-npe-moving-emitter");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

interface Scene302State {
    emitterX: number;
    emitterY: number;
    emitterAngle: number;
    providerCalls: number;
    particles: number;
    animationFrozen: string | undefined;
    error: string | undefined;
}

async function readState(canvas: import("@playwright/test").Locator): Promise<Scene302State> {
    return canvas.evaluate((element) => {
        const data = (element as HTMLCanvasElement).dataset;
        return {
            emitterX: Number(data.emitterX),
            emitterY: Number(data.emitterY),
            emitterAngle: Number(data.emitterAngle),
            providerCalls: Number(data.providerCalls),
            particles: Number(data.particles),
            animationFrozen: data.animationFrozen,
            error: data.error,
        };
    });
}

function countVisiblePixels(screenshot: Buffer): number {
    const png = PNG.sync.read(screenshot);
    let count = 0;
    for (let offset = 0; offset < png.data.length; offset += 4) {
        if (png.data[offset]! + png.data[offset + 1]! + png.data[offset + 2]! > 48) {
            count++;
        }
    }
    return count;
}

function countChangedPixels(first: Buffer, second: Buffer): number {
    const firstPng = PNG.sync.read(first);
    const secondPng = PNG.sync.read(second);
    expect(secondPng.width).toBe(firstPng.width);
    expect(secondPng.height).toBe(firstPng.height);
    let count = 0;
    for (let offset = 0; offset < firstPng.data.length; offset += 4) {
        const difference =
            Math.abs(firstPng.data[offset]! - secondPng.data[offset]!) +
            Math.abs(firstPng.data[offset + 1]! - secondPng.data[offset + 1]!) +
            Math.abs(firstPng.data[offset + 2]! - secondPng.data[offset + 2]!);
        if (difference > 3) {
            count++;
        }
    }
    return count;
}

test.skip(!!sceneConfig.skipParity, "Scene 302 skipped via skipParity in scene-config.json");

test("Scene 302 frozen moving NPE emitter matches the committed Babylon.js golden", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/scene302.html?seekTime=${SCENE302_CAPTURE_SEEK_TIME}`);

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(canvas).toHaveAttribute("data-animation-frozen", "true");
    await expect(canvas).not.toHaveAttribute("data-error", /.+/);
    const state = await readState(canvas);
    expect(state.error).toBeUndefined();
    expect(Number.isFinite(state.emitterX)).toBe(true);
    expect(Number.isFinite(state.emitterY)).toBe(true);
    expect(Number.isFinite(state.emitterAngle)).toBe(true);
    expect(state.providerCalls).toBeGreaterThan(120);
    expect(state.particles).toBeGreaterThan(0);

    await page.waitForTimeout(500);
    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await canvas.screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);
    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});

test("Scene 302 live mode continuously moves the provider and particles", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/scene302.html");

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(canvas).not.toHaveAttribute("data-animation-frozen", /.+/);
    await expect(canvas).not.toHaveAttribute("data-error", /.+/);
    await expect.poll(async () => (await readState(canvas)).particles).toBeGreaterThan(0);

    const firstState = await readState(canvas);
    const firstScreenshot = await canvas.screenshot();
    await page.waitForTimeout(400);
    const secondState = await readState(canvas);
    const secondScreenshot = await canvas.screenshot();

    expect(secondState.emitterX).not.toBe(firstState.emitterX);
    expect(secondState.emitterY).not.toBe(firstState.emitterY);
    expect(secondState.emitterAngle).not.toBe(firstState.emitterAngle);
    expect(secondState.providerCalls).toBeGreaterThan(firstState.providerCalls);
    expect(countVisiblePixels(firstScreenshot)).toBeGreaterThan(100);
    expect(countVisiblePixels(secondScreenshot)).toBeGreaterThan(100);
    expect(countChangedPixels(firstScreenshot, secondScreenshot)).toBeGreaterThan(100);
});
