import { expect, test } from "../parity-fixtures";
import { PNG } from "pngjs";

import { getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(300);

interface Scene300State {
    bridge: string | undefined;
    bindingActive: string | undefined;
    liveSamples: number;
    systemAlive: number;
    layerCount: number;
    particleAge: number;
    rendererLayers: number;
    drawCalls: number;
    animationFrozen: string | undefined;
}

async function readState(canvas: import("@playwright/test").Locator): Promise<Scene300State> {
    return canvas.evaluate((element) => {
        const data = (element as HTMLCanvasElement).dataset;
        return {
            bridge: data.bridge,
            bindingActive: data.bindingActive,
            liveSamples: Number(data.liveSamples),
            systemAlive: Number(data.systemAlive),
            layerCount: Number(data.layerCount),
            particleAge: Number(data.particleAge),
            rendererLayers: Number(data.rendererLayers),
            drawCalls: Number(data.drawCalls),
            animationFrozen: data.animationFrozen,
        };
    });
}

function countOrientationMarkerPixels(png: PNG, top: number, bottom: number): number {
    let count = 0;
    for (let y = top; y < bottom; y++) {
        for (let x = 84; x < 108; x++) {
            const offset = (y * png.width + x) * 4;
            if (png.data[offset]! > 140 && png.data[offset + 1]! > 30 && png.data[offset + 2]! < 120) {
                count++;
            }
        }
    }
    return count;
}

test("Scene 300 renders a frozen NPE system through the Sprite2D bridge", async ({ page }) => {
    test.setTimeout(90_000);
    expect(sceneConfig.skipParity).toBe(true);

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/scene300.html");

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(canvas).not.toHaveAttribute("data-error", /.+/);

    const initial = await readState(canvas);
    expect(initial.bridge).toBe("particle-sprite-2d");
    expect(initial.bindingActive).toBe("true");
    expect(initial.liveSamples).toBeGreaterThan(0);
    expect(initial.systemAlive).toBeGreaterThan(0);
    expect(initial.layerCount).toBe(initial.systemAlive);
    expect(Number.isFinite(initial.particleAge)).toBe(true);
    expect(initial.rendererLayers).toBe(1);
    expect(initial.drawCalls).toBeGreaterThan(0);
    expect(initial.animationFrozen).toBe("true");

    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                let remaining = 5;
                const next = (): void => {
                    remaining--;
                    if (remaining === 0) {
                        resolve();
                    } else {
                        requestAnimationFrame(next);
                    }
                };
                requestAnimationFrame(next);
            })
    );
    const settled = await readState(canvas);
    expect(settled.liveSamples).toBeGreaterThan(initial.liveSamples);
    expect(settled.systemAlive).toBe(initial.systemAlive);
    expect(settled.layerCount).toBe(initial.layerCount);
    expect(settled.particleAge).toBe(initial.particleAge);

    const png = PNG.sync.read(await canvas.screenshot());
    let flarePixels = 0;
    for (let i = 0; i < png.data.length; i += 4) {
        if (png.data[i]! > 100 && png.data[i + 1]! > 35) {
            flarePixels++;
        }
    }
    expect(flarePixels).toBeGreaterThan(100);

    // The isolated 64 px marker sprite is centered at (96, 96). Its atlas mark is near
    // the cell's top edge, so a vertical texture/UV inversion moves it to the lower band.
    const upperMarkerPixels = countOrientationMarkerPixels(png, 66, 80);
    const lowerMarkerPixels = countOrientationMarkerPixels(png, 112, 126);
    expect(upperMarkerPixels).toBeGreaterThan(80);
    expect(lowerMarkerPixels).toBeLessThan(8);
});
