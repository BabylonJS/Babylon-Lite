import { expect, test } from "@playwright/test";
import type { MeshDrawRangeTest } from "../../../lab/lite/src/mesh-draw-range-test";

declare global {
    interface Window {
        meshDrawRangeTest: MeshDrawRangeTest;
        pickReadback: { waiting: boolean; release(): void };
    }
}

for (const advanced of [false, true]) {
    for (const empty of [false, true]) {
        test(`changed draw range invalidates pending detailed pick (${advanced ? "advanced" : "regular"}, ${empty ? "empty" : "other triangle"})`, async ({ page }) => {
            await page.goto(`/lite/mesh-draw-range-test.html${advanced ? "?advanced" : ""}`);
            await expect(page.locator("canvas")).toHaveAttribute("data-ready", "true");
            const baseline = await page.evaluate(async () => {
                window.meshDrawRangeTest.select("card", { vertices: { offset: 0, count: 4 }, indices: { offset: 0, count: 3 } });
                return window.meshDrawRangeTest.pick();
            });
            expect(baseline.detailed).toBe(true);
            expect(baseline.hit).toBe(true);
            expect(baseline.faceId).toBe(0);
            expect(baseline.uv?.every(Number.isFinite)).toBe(true);
            await page.evaluate(() => {
                let release!: () => void;
                const gate = new Promise<void>((resolve) => {
                    release = resolve;
                });
                window.pickReadback = { waiting: false, release };
                const original = GPUBuffer.prototype.mapAsync;
                GPUBuffer.prototype.mapAsync = async function (...args) {
                    await Reflect.apply(original, this, args);
                    if (this.label.startsWith("pick-")) {
                        window.pickReadback.waiting = true;
                        await gate;
                    }
                };
            });
            const pending = page.evaluate(() => window.meshDrawRangeTest.pick());
            await page.waitForFunction(() => window.pickReadback.waiting);
            await page.evaluate((empty) => {
                window.meshDrawRangeTest.select("card", {
                    vertices: { offset: 0, count: empty ? 0 : 4 },
                    indices: { offset: empty ? 0 : 3, count: empty ? 0 : 3 },
                });
                window.pickReadback.release();
            }, empty);
            const result = await pending;
            expect(result.hit).toBe(false);
            expect(result.faceId).toBe(-1);
            expect(result.normal).toBeNull();
            expect(result.uv).toBeNull();
            const next = await page.evaluate(() => window.meshDrawRangeTest.pick());
            expect(next.hit).toBe(false);
        });
    }
}
