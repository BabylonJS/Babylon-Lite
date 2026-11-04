import { expect, test } from "../parity-fixtures";
import { PNG } from "pngjs";

import { getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(303);

interface Scene303State {
    sortEnabled: string | undefined;
    spriteCount: number;
    liveMoverIndex: number;
    liveBackIndex: number;
    firstTieIndex: number;
    secondTieIndex: number;
    biasedFrontIndex: number;
    biasBackIndex: number;
    liveYPick: number;
    tiePick: number;
    biasPick: number;
    mutations: number;
    drawCalls: number;
    canvasWidth: number;
    canvasHeight: number;
    animationFrozen: string | undefined;
}

function pixelRgb(png: PNG, x: number, y: number): number[] {
    const offset = (y * png.width + x) * 4;
    return [png.data[offset]!, png.data[offset + 1]!, png.data[offset + 2]!];
}

function expectRgb(actual: readonly number[], expected: readonly number[], tolerance = 3): void {
    for (let channel = 0; channel < 3; channel++) {
        expect(Math.abs(actual[channel]! - expected[channel]!), `channel ${channel}: expected ${expected[channel]}, got ${actual[channel]}`).toBeLessThanOrEqual(tolerance);
    }
}

test("Scene 303 visibly Y-sorts a live Y change, stable tie, and biased overlap", async ({ page }) => {
    test.setTimeout(90_000);
    expect(sceneConfig.skipParity).toBe(true);

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/scene303.html");

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(canvas).not.toHaveAttribute("data-error", /.+/);
    const state = await canvas.evaluate((element): Scene303State => {
        const data = (element as HTMLCanvasElement).dataset;
        return {
            sortEnabled: data.sortEnabled,
            spriteCount: Number(data.spriteCount),
            liveMoverIndex: Number(data.liveMoverIndex),
            liveBackIndex: Number(data.liveBackIndex),
            firstTieIndex: Number(data.firstTieIndex),
            secondTieIndex: Number(data.secondTieIndex),
            biasedFrontIndex: Number(data.biasedFrontIndex),
            biasBackIndex: Number(data.biasBackIndex),
            liveYPick: Number(data.liveYPick),
            tiePick: Number(data.tiePick),
            biasPick: Number(data.biasPick),
            mutations: Number(data.mutations),
            drawCalls: Number(data.drawCalls),
            canvasWidth: Number(data.canvasWidth),
            canvasHeight: Number(data.canvasHeight),
            animationFrozen: data.animationFrozen,
        };
    });

    expect(state.sortEnabled).toBe("true");
    expect(state.spriteCount).toBe(6);
    expect([state.liveMoverIndex, state.liveBackIndex, state.firstTieIndex, state.secondTieIndex, state.biasedFrontIndex, state.biasBackIndex]).toEqual([0, 1, 2, 3, 4, 5]);
    expect.soft(state.liveYPick, "live-Y overlap pick").toBe(state.liveMoverIndex);
    expect(state.tiePick).toBe(state.secondTieIndex);
    expect.soft(state.biasPick, "biased overlap pick").toBe(state.biasedFrontIndex);
    expect(state.mutations).toBe(1);
    expect(state.drawCalls).toBeGreaterThan(0);
    expect([state.canvasWidth, state.canvasHeight]).toEqual([1280, 720]);
    expect(state.animationFrozen).toBe("true");

    const png = PNG.sync.read(await canvas.screenshot());
    expectRgb(pixelRgb(png, 370, 270), [236, 80, 96]);
    expectRgb(pixelRgb(png, 785, 260), [70, 214, 148]);
    expectRgb(pixelRgb(png, 1010, 250), [66, 132, 238]);

    let figurePixels = 0;
    for (let offset = 0; offset < png.data.length; offset += 4) {
        if (png.data[offset]! > 35 || png.data[offset + 1]! > 80 || png.data[offset + 2]! > 80) {
            figurePixels++;
        }
    }
    expect(figurePixels).toBeGreaterThan(20_000);
});
