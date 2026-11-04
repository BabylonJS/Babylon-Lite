import { expect, test } from "../parity/parity-fixtures";

interface ComputeLifecycleResults {
    error: string | null;
    compileCount: number;
    firstDispatchValue: number | null;
    reboundDispatchValue: number | null;
    frameReadValue: number | null;
}

test("compat compute lifecycle uses real WebGPU resources", async ({ page }) => {
    await page.goto("/lite/compute-lifecycle-test.html");

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    const results = await page.evaluate(() => (window as unknown as { __computeLifecycleTest: ComputeLifecycleResults }).__computeLifecycleTest);

    expect(results.error).toBeNull();
    expect(results.compileCount).toBe(1);
    expect(results.firstDispatchValue).toBe(42);
    expect(results.reboundDispatchValue).toBe(100);
    expect(results.frameReadValue).toBe(0);
});
