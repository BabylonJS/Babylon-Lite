import { test, expect } from "@playwright/test";

test.describe("Dispose", () => {
    test("scene.dispose() + engine.dispose() release GPU resources without errors", async ({ page }) => {
        // Check if WebGPU is actually functional (not just present)
        await page.goto("about:blank");
        const hasWebGPU = await page.evaluate(async () => {
            if (!navigator.gpu) {
                return false;
            }
            const adapter = await navigator.gpu.requestAdapter();
            return !!adapter;
        });
        test.skip(!hasWebGPU, "WebGPU not available — requires GPU hardware");

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
