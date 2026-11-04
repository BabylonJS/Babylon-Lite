import { expect, test } from "../parity-fixtures";
import { PNG } from "pngjs";

import { getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(301);
const DESTINATION = [0.65, 0.45, 0.25] as const;
const TINT = [0.3, 0.8, 0.45] as const;
const OPACITY = 0.75;

interface Scene301State {
    bindingActive: string | undefined;
    multiplyLayers: number;
    multiplyAddLayers: number;
    passOrder: string | undefined;
    rendererLayers: number;
    drawCalls: number;
    multiplyX: number;
    multiplyAddX: number;
    centerY: number;
    spriteSize: number;
    animationFrozen: string | undefined;
}

function expectedMultiply(): number[] {
    return DESTINATION.map((destination, index) => Math.round(destination * (TINT[index]! * OPACITY + 1 - OPACITY) * 255));
}

function expectedMultiplyAdd(): number[] {
    const multiply = DESTINATION.map((destination, index) => destination * (TINT[index]! * OPACITY + 1 - OPACITY));
    return multiply.map((value, index) => Math.round((value + TINT[index]! * OPACITY) * 255));
}

function pixelRgb(png: PNG, x: number, y: number): number[] {
    const offset = (y * png.width + x) * 4;
    return [png.data[offset]!, png.data[offset + 1]!, png.data[offset + 2]!];
}

function expectRgb(actual: number[], expected: readonly number[], tolerance = 3): void {
    for (let channel = 0; channel < 3; channel++) {
        expect(Math.abs(actual[channel]! - expected[channel]!), `channel ${channel}: expected ${expected[channel]}, got ${actual[channel]}`).toBeLessThanOrEqual(tolerance);
    }
}

test("Scene 301 renders exact NPE Multiply and MultiplyAdd through Sprite2D", async ({ page }) => {
    test.setTimeout(90_000);
    expect(sceneConfig.skipParity).toBe(true);

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/scene301.html");

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(canvas).not.toHaveAttribute("data-error", /.+/);
    const state = await canvas.evaluate((element): Scene301State => {
        const data = (element as HTMLCanvasElement).dataset;
        return {
            bindingActive: data.bindingActive,
            multiplyLayers: Number(data.multiplyLayers),
            multiplyAddLayers: Number(data.multiplyAddLayers),
            passOrder: data.passOrder,
            rendererLayers: Number(data.rendererLayers),
            drawCalls: Number(data.drawCalls),
            multiplyX: Number(data.multiplyX),
            multiplyAddX: Number(data.multiplyAddX),
            centerY: Number(data.centerY),
            spriteSize: Number(data.spriteSize),
            animationFrozen: data.animationFrozen,
        };
    });

    expect(state.bindingActive).toBe("true");
    expect(state.multiplyLayers).toBe(1);
    expect(state.multiplyAddLayers).toBe(2);
    expect(state.passOrder).toBe("p4,p2");
    expect(state.rendererLayers).toBe(3);
    expect(state.drawCalls).toBeGreaterThanOrEqual(3);
    expect(state.animationFrozen).toBe("true");

    const png = PNG.sync.read(await canvas.screenshot());
    expectRgb(pixelRgb(png, state.multiplyX, state.centerY), expectedMultiply());
    expectRgb(pixelRgb(png, state.multiplyAddX, state.centerY), expectedMultiplyAdd());

    const transparentSampleOffset = Math.round(state.spriteSize * 0.5 - 4);
    const clearRgb = DESTINATION.map((value) => Math.round(value * 255));
    expectRgb(pixelRgb(png, state.multiplyX - transparentSampleOffset, state.centerY), clearRgb, 1);
    expectRgb(pixelRgb(png, state.multiplyAddX - transparentSampleOffset, state.centerY), clearRgb, 1);
});
