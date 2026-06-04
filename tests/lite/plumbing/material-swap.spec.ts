import { test, expect } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { PNG } from "pngjs";

function getCenterPixel(pngPath: string): [number, number, number] {
    const data = fs.readFileSync(pngPath);
    const img = PNG.sync.read(data);
    const cx = (img.width / 2) | 0,
        cy = (img.height / 2) | 0;
    const idx = (cy * img.width + cx) * 4;
    return [img.data[idx]!, img.data[idx + 1]!, img.data[idx + 2]!];
}

test.describe("Material Swap", () => {
    test("mesh.material = newMat changes rendering on next frame", async ({ page }) => {
        await page.goto("/material-swap-test.html");

        // Wait for red phase
        await page.waitForFunction(() => (window as any).phase === "red", { timeout: 10_000 });
        await page.waitForTimeout(100);

        // Screenshot the red sphere
        const redPath = path.join(__dirname, "../../test-results/material-swap-red.png");
        fs.mkdirSync(path.dirname(redPath), { recursive: true });
        await page.locator("canvas").screenshot({ path: redPath });

        // Trigger swap to green
        await page.evaluate(() => (window as any).swapToGreen());

        // Wait for green phase
        await page.waitForFunction(() => (window as any).phase === "green", { timeout: 10_000 });
        await page.waitForTimeout(100);

        // Screenshot the green sphere
        const greenPath = path.join(__dirname, "../../test-results/material-swap-green.png");
        await page.locator("canvas").screenshot({ path: greenPath });

        // Check center pixel of each screenshot
        const [rr, rg] = getCenterPixel(redPath);
        const [gr, gg] = getCenterPixel(greenPath);

        console.log(`Red phase center pixel: R=${rr} G=${rg}`);
        console.log(`Green phase center pixel: R=${gr} G=${gg}`);

        // Red phase: should be reddish (R > G)
        expect(rr).toBeGreaterThan(rg + 20);
        // Green phase: should be greenish (G > R)
        expect(gg).toBeGreaterThan(gr + 20);
    });
});
