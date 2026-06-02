import { test, expect } from "@playwright/test";

test.describe("Dispose", () => {
    test("scene.dispose() + engine.dispose() release GPU resources without errors", async ({ page }) => {
        await page.goto("/dispose-test.html");
        await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });

        // Verify both cycles completed
        const disposed = await page.evaluate(() => (window as any).disposed);
        expect(disposed).toBe(true);

        const recreated = await page.evaluate(() => (window as any).recreated);
        expect(recreated).toBe(true);

        // Verify no GPU validation errors
        const gpuErrors = await page.evaluate(() => (window as any).gpuErrors);
        expect(gpuErrors).toEqual([]);
    });
});
